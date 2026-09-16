import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";

/**
 * A protected route plugin.
 *
 * Wrap protected routes in `fastify.withAuth(async (scope) => { ... })`. The
 * scope authenticates every request (populating `request.user`), documents the
 * auth error responses (400/401) automatically, and translates auth failures
 * into the right status codes — no manual `preHandler` or response merging is
 * needed. After successful authentication the verified user is available on
 * `request.user`.
 */
const authExample: FastifyPluginAsync = async (
  fastify: FastifyTypebox,
): Promise<void> => {
  fastify.withAuth(async (fastify) => {
    fastify.get(
      "/",
      {
        schema: {
          summary: "Auth Example",
          tags: ["Auth"],
          security: [{ Auth: [] }],
          response: {
            200: Type.String({
              description: "The authenticated user's username.",
            }),
          },
        },
      },
      async (request) => request.user.username,
    );
  });
};

export default authExample;
