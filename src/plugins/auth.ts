import { createHash, timingSafeEqual } from "node:crypto";
import { STATUS_CODES } from "node:http";
import type {
  ContextConfigDefault,
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifySchema,
  FastifyTypeProvider,
  FastifyTypeProviderDefault,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
  RawServerDefault,
  RouteGenericInterface,
} from "fastify";
import type {
  FastifyRequestType,
  ResolveFastifyRequestType,
} from "fastify/types/type-provider";
import fp from "fastify-plugin";
import { type Static, type TSchema, type TSchemaOptions, Type } from "typebox";
import { users as defaultUsers, type InternalUser } from "../auth/users.js";

/**
 * Indicates that a bearer token could not be trusted.
 *
 * The token-verification error is retained as `cause` for server-side
 * diagnostics. Its HTTP status is always 401.
 */
export class UnauthorizedError extends Error {
  override cause: Error;
  readonly statusCode = 401;

  constructor(cause: Error) {
    super(`${cause.name}: ${cause.message}`, { cause });
    this.cause = cause;
    this.name = "UnauthorizedError";
  }
}

/**
 * Indicates that an HTTP Authorization header is missing or malformed.
 *
 * Missing credentials produce 401; malformed headers and unsupported schemes
 * produce 400.
 */
export class AuthorizationHeaderError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 401,
  ) {
    super(message);
    this.name = "AuthorizationHeaderError";
  }
}

/** The application user resolved from an authenticated bearer token. */
export interface AuthUser {
  id: string;
  /** The user's username from the static token table. */
  username: string;
  /** The user's display name; may be null. */
  name: string | null;
}

/** Configuration of the auth plugin. */
export interface AuthPluginOptions {
  /**
   * Bypasses token verification and authenticates every scoped request as a
   * fixed anonymous user. Intended only for local development and tests.
   */
  authSkip?: boolean;
  /**
   * The static token table requests are authenticated against.
   *
   * Defaults to the sample users in `src/auth/users.ts`.
   */
  users?: InternalUser[];
}

declare const authenticatedRequest: unique symbol;

/** Type-level marker applied to Fastify scopes protected by `withAuth`. */
export type AuthenticatedTypeProvider = {
  readonly [authenticatedRequest]: true;
};

/**
 * A Fastify instance whose route handlers receive authenticated requests.
 *
 * The original type provider is retained, so schema inference continues to
 * work inside the scope.
 */
export type AuthenticatedFastifyInstance<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequest extends
    RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReply extends
    RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
> = FastifyInstance<
  RawServer,
  RawRequest,
  RawReply,
  Logger,
  TypeProvider & AuthenticatedTypeProvider
>;

/**
 * Creates an encapsulated Fastify scope in which every route is authenticated.
 *
 * Authentication runs before route-level hooks, and authentication response
 * schemas are added automatically. The outer Fastify instance remains
 * unchanged and its request identity stays `undefined`.
 */
export type WithAuthMethod<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequest extends
    RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReply extends
    RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
> = (
  routes: (
    fastify: AuthenticatedFastifyInstance<
      RawServer,
      RawRequest,
      RawReply,
      Logger,
      TypeProvider
    >,
  ) => Promise<void> | void,
) => FastifyInstance<RawServer, RawRequest, RawReply, Logger, TypeProvider>;

/** The fixed anonymous user requests are authenticated as under `authSkip`. */
const ANONYMOUS_USER: AuthUser = {
  id: "00000000-0000-0000-0000-000000000000",
  username: "anonymous",
  name: null,
};

const includesAuthResponses = Symbol("includesAuthResponses");

/** A TypeBox schema that emits JSON Schema `oneOf` rather than `anyOf`. */
export interface TUnionOneOf<T extends TSchema[]> extends TSchema {
  "~kind": "UnionOneOf";
  static: { [K in keyof T]: Static<T[K]> }[number];
  oneOf: T;
}

/** Creates a TypeBox-compatible JSON Schema `oneOf`. */
export function UnionOneOf<T extends TSchema[]>(
  oneOf: [...T],
  options: TSchemaOptions = {},
) {
  return { ...options, oneOf } as TUnionOneOf<T>;
}

/** A Fastify response schema keyed by status code, range, or `default`. */
export type ResponseSchema = Record<string, TSchema>;

/**
 * Combines response schemas, representing duplicate status codes as `oneOf`.
 */
export function mergeResponse(responses: ResponseSchema[]): ResponseSchema {
  const merged: ResponseSchema = {};

  for (const response of responses) {
    for (const [status, schema] of Object.entries(response)) {
      const existingSchema = merged[status];
      merged[status] = existingSchema
        ? UnionOneOf([schema, existingSchema])
        : schema;
    }
  }

  if (responses.includes(AuthResponseSchema)) {
    Object.defineProperty(merged, includesAuthResponses, { value: true });
  }

  return merged;
}

/** Response schemas automatically added to routes inside `fastify.withAuth`. */
export const AuthResponseSchema: ResponseSchema = {
  400: UnionOneOf(
    [
      Type.Literal("Invalid Authorization Header", {
        description: "The Authorization header is invalid.",
      }),
      Type.Literal("Invalid Authorization Scheme", {
        description: "The Authorization scheme is invalid.",
      }),
    ],
    {
      description: "Errors produced while parsing bearer authentication.",
    },
  ),
  401: UnionOneOf(
    [
      Type.Literal("Missing Authorization Header", {
        description: "The Authorization header is missing.",
      }),
      Type.Any({
        description:
          "The token verification error returned for an unauthorized request.",
      }),
    ],
    {
      description: "Errors produced while authenticating a request.",
    },
  ),
};

/** Adds authentication responses unless they have already been merged. */
export function mergeAuthResponse(response: ResponseSchema): ResponseSchema {
  if (
    (
      response as ResponseSchema & {
        [includesAuthResponses]?: boolean;
      }
    )[includesAuthResponses]
  ) {
    return response;
  }

  // Do not install an authentication-only 400 schema when the route does not
  // already define one. Fastify may emit its standard validation error object
  // for any validated request, and narrowing that otherwise-unspecified
  // response to auth header strings turns a legitimate 400 into a serializer
  // failure. Routes with an explicit 400 retain it and merge in the auth cases.
  const authResponse =
    response["400"] === undefined
      ? { 401: AuthResponseSchema["401"]! }
      : AuthResponseSchema;
  const merged = mergeResponse([response, authResponse]);
  Object.defineProperty(merged, includesAuthResponses, { value: true });
  return merged;
}

/**
 * The Fastify auth plugin installing the internal bearer-token system.
 *
 * Parses the Authorization header, verifies the bearer token against the
 * static token table, populates `request.user`, and documents the
 * authentication error responses on every route inside `fastify.withAuth`.
 */
const auth: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  const { authSkip: skip = false } = opts;
  const knownUsers = opts.users ?? defaultUsers;

  if (skip) {
    fastify.log.warn("Skip Auth: ON");
  }

  // Tokens are sha256-hashed on both sides so `timingSafeEqual` compares
  // fixed-length digests without leaking timing information about the stored
  // token bytes. Token hashes are precomputed at registration so request-time
  // verification only hashes the presented token.
  const tokenTable = knownUsers.map((user) => ({
    user,
    token: createHash("sha256").update(user.token).digest(),
  }));

  async function authenticate(token: string): Promise<AuthUser> {
    const candidate = createHash("sha256").update(token).digest();
    const user = tokenTable.find((entry) =>
      timingSafeEqual(candidate, entry.token),
    )?.user;
    if (!user) {
      throw new UnauthorizedError(new Error("Unknown bearer token"));
    }
    return { id: user.id, username: user.username, name: user.name };
  }

  async function authenticateRequest(
    request: FastifyRequest,
  ): Promise<AuthUser> {
    if (skip) {
      // A true bypass: every scoped request is authenticated as the fixed
      // anonymous user, regardless of any Authorization header, so a stale
      // token left in an HTTP client cannot cause a confusing 401.
      return ANONYMOUS_USER;
    }

    const authorization = request.headers.authorization;
    if (authorization === undefined) {
      throw new AuthorizationHeaderError("Missing Authorization Header", 401);
    }

    const parts = authorization.split(" ");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new AuthorizationHeaderError("Invalid Authorization Header", 400);
    }
    const [scheme, token] = parts;
    if (scheme !== "Bearer") {
      throw new AuthorizationHeaderError("Invalid Authorization Scheme", 400);
    }

    return authenticate(token);
  }

  fastify.decorateRequest("user", undefined);

  fastify.decorate("authenticate", authenticate);

  fastify.decorate("withAuth", function withAuth(
    this: FastifyInstance,
    routes: (scope: AuthenticatedFastifyInstance) => Promise<void> | void,
  ) {
    return this.register(async (scope) => {
      scope.addHook("onRoute", (routeOptions) => {
        const response = (routeOptions.schema?.response ??
          {}) as ResponseSchema;
        routeOptions.schema = {
          ...routeOptions.schema,
          response: mergeAuthResponse(response),
        };
      });
      scope.setErrorHandler((error, _request, reply) => {
        if (
          error instanceof AuthorizationHeaderError ||
          error instanceof UnauthorizedError
        ) {
          return reply.status(error.statusCode).send(error.message);
        }
        if (
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error
        ) {
          const { statusCode } = error as { statusCode: unknown };
          if (
            typeof statusCode === "number" &&
            statusCode >= 400 &&
            statusCode < 500
          ) {
            // Preserve client-error statuses (e.g. 400 FST_ERR_VALIDATION).
            // Send a pre-serialized standard error body, which bypasses
            // response-schema serialization.
            const { code, message } = error as {
              code?: string;
              message?: string;
            };
            return reply
              .code(statusCode)
              .header("content-type", "application/json; charset=utf-8")
              .send(
                JSON.stringify({
                  error: STATUS_CODES[statusCode],
                  code,
                  message,
                  statusCode,
                }),
              );
          }
        }
        throw error;
      });
      scope.addHook("onRequest", async (request, reply) => {
        const user = await authenticateRequest(request);
        Object.assign(request, { user });
        if (skip) {
          reply.header("X-Auth-Skip", "true");
        }
      });
      await routes(scope as unknown as AuthenticatedFastifyInstance);
    });
  } as WithAuthMethod);
};

/**
 * Fastify plugin that installs the internal bearer-token authentication.
 *
 * Static users live in `src/auth/users.ts`; configure them via the `users`
 * plugin option. For usage, see `src/routes/events/index.ts`.
 */
export default fp(auth, { name: "auth" });

declare module "fastify" {
  export interface FastifyInstance<
    RawServer extends RawServerBase = RawServerDefault,
    RawRequest extends
      RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
    RawReply extends
      RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
    Logger extends FastifyBaseLogger = FastifyBaseLogger,
    TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
  > {
    /** Verifies a bearer token and returns its normalized application user. */
    authenticate(token: string): Promise<AuthUser>;
    /**
     * Creates an authenticated route scope whose handlers receive a non-null
     * `request.user`.
     */
    withAuth: WithAuthMethod<
      RawServer,
      RawRequest,
      RawReply,
      Logger,
      TypeProvider
    >;
  }

  export interface FastifyRequest<
    RouteGeneric extends RouteGenericInterface = RouteGenericInterface,
    RawServer extends RawServerBase = RawServerDefault,
    RawRequest extends
      RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
    SchemaCompiler extends FastifySchema = FastifySchema,
    TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
    ContextConfig = ContextConfigDefault,
    Logger extends FastifyBaseLogger = FastifyBaseLogger,
    RequestType extends FastifyRequestType = ResolveFastifyRequestType<
      TypeProvider,
      SchemaCompiler,
      RouteGeneric
    >,
  > {
    /** The authenticated user in a `withAuth` scope; otherwise `undefined`. */
    user: TypeProvider extends AuthenticatedTypeProvider ? AuthUser : undefined;
  }
}
