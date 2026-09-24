import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { AuthUser } from "./plugins/auth.js";
import { RateLimitMemoryStore } from "./rate-limit-store.js";

export interface RateLimitOptions {
  rateLimitIpMax?: number;
  rateLimitReadMax?: number;
  rateLimitWriteMax?: number;
  rateLimitWindowMs?: number;
}

type Limiter = ReturnType<FastifyInstance["createRateLimit"]>;

async function enforceLimit(
  limiter: Limiter,
  scope: "ip" | "user-read" | "user-write",
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const result = await limiter(request);
  if (result.isAllowed) return;
  reply.header("X-RateLimit-Scope", scope);
  reply.header("X-RateLimit-Limit", result.max);
  reply.header("X-RateLimit-Remaining", result.remaining);
  reply.header("X-RateLimit-Reset", result.ttlInSeconds);
  if (result.isExceeded) {
    reply.header("Retry-After", result.ttlInSeconds);
    throw Object.assign(
      new Error("Too many requests. Retry after the indicated delay."),
      { statusCode: 429 },
    );
  }
}

/** In-memory counters for one API process; register before application routes. */
export default fp<RateLimitOptions>(
  async (app, options) => {
    const ipMax = options.rateLimitIpMax ?? 120;
    const readMax = options.rateLimitReadMax ?? 120;
    const writeMax = options.rateLimitWriteMax ?? 30;
    const timeWindow = options.rateLimitWindowMs ?? 60_000;
    if (
      ![ipMax, readMax, writeMax, timeWindow].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    ) {
      throw new Error(
        "Rate limits and their window must be positive safe integers.",
      );
    }
    await app.register(rateLimit, {
      global: false,
      timeWindow,
      skipOnError: false,
      store: RateLimitMemoryStore,
    });
    // Separate limiter instances have separate stores. Each instance is shared
    // across routes rather than allocating a fresh allowance for each endpoint.
    const ipLimiter = app.createRateLimit({ max: ipMax });
    const userKey = (request: FastifyRequest) => {
      if (!request.user)
        throw new Error("User rate limiting requires authentication.");
      return request.getDecorator<AuthUser>("user").id;
    };
    const readLimiter = app.createRateLimit({
      max: readMax,
      keyGenerator: userKey,
    });
    const writeLimiter = app.createRateLimit({
      max: writeMax,
      keyGenerator: userKey,
    });

    app.addHook("onRequest", async (request, reply) => {
      await enforceLimit(ipLimiter, "ip", request, reply);
    });
    // Auth runs in onRequest. preParsing runs afterwards but before body parsing
    // and validation, so invalid authenticated requests still consume allowance.
    app.addHook("preParsing", async (request, reply, payload) => {
      if (request.user) {
        const read = request.method === "GET" || request.method === "HEAD";
        await enforceLimit(
          read ? readLimiter : writeLimiter,
          read ? "user-read" : "user-write",
          request,
          reply,
        );
      }
      return payload;
    });
  },
  { name: "request-rate-limits" },
);
