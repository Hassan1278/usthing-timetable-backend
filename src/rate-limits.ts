import type { FastifyReply } from "fastify";
import fp from "fastify-plugin";
import ipaddr from "ipaddr.js";
import type { AuthUser } from "./plugins/auth.js";
import { type RateCounter, RateLimitMongoStore } from "./rate-limit-store.js";

export interface RateLimitOptions {
  rateLimitIpMax?: number;
  rateLimitReadMax?: number;
  rateLimitWriteMax?: number;
  rateLimitWindowMs?: number;
}

function ipKey(address: string): string {
  const parsed = ipaddr.process(address);
  if (parsed.kind() === "ipv4") return parsed.toString();
  // Group IPv6 addresses by /56, preserving the previous limiter's subnet policy.
  const bytes = parsed.toByteArray();
  bytes.fill(0, 7);
  return `${ipaddr.fromByteArray(bytes).toNormalizedString()}/56`;
}

/** Shared MongoDB counters; failures reject requests rather than bypassing limits. */
export default fp<RateLimitOptions>(
  async (app, options) => {
    const ipMax = options.rateLimitIpMax ?? 120;
    const readMax = options.rateLimitReadMax ?? 120;
    const writeMax = options.rateLimitWriteMax ?? 30;
    const timeWindow = options.rateLimitWindowMs ?? 60_000;
    if (
      ![ipMax, readMax, writeMax, timeWindow].every(
        (value) =>
          Number.isSafeInteger(value) &&
          value > 0 &&
          value < Number.MAX_SAFE_INTEGER,
      )
    ) {
      throw new Error(
        "Rate limits and their window must be positive safe integers below Number.MAX_SAFE_INTEGER.",
      );
    }
    let store: RateLimitMongoStore;
    app.addHook("onReady", async () => {
      const collection = app.mongo.db!.collection<RateCounter>("rate_limits");
      await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      store = new RateLimitMongoStore(collection);
    });
    async function enforce(
      scope: string,
      key: string,
      max: number,
      reply: FastifyReply,
    ) {
      let result: Awaited<ReturnType<RateLimitMongoStore["consume"]>>;
      try {
        result = await store.consume(scope, key, timeWindow, max);
      } catch {
        throw Object.assign(
          new Error("Request limiting unavailable. Try again later."),
          { statusCode: 503 },
        );
      }
      reply.header("X-RateLimit-Scope", scope);
      reply.header("X-RateLimit-Limit", max);
      reply.header("X-RateLimit-Remaining", result.remaining);
      reply.header("X-RateLimit-Reset", result.retryAfter);
      if (result.allowed) return;
      reply.header("Retry-After", result.retryAfter);
      throw Object.assign(
        new Error("Too many requests. Retry after the indicated delay."),
        { statusCode: 429 },
      );
    }
    app.addHook("onRequest", async (request, reply) => {
      await enforce("ip", ipKey(request.ip), ipMax, reply);
    });
    app.addHook("preParsing", async (request, reply, payload) => {
      if (request.user) {
        const read = request.method === "GET" || request.method === "HEAD";
        await enforce(
          read ? "user-read" : "user-write",
          request.getDecorator<AuthUser>("user").id,
          read ? readMax : writeMax,
          reply,
        );
      }
      return payload;
    });
  },
  { name: "request-rate-limits" },
);
