import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import { HttpError } from "../../plugins/sensible.js";

/**
 * Example routes showing the shape of a public route service.
 *
 * Public routes live outside `fastify.withAuth`, so no authentication runs and
 * `request.user` stays `undefined`. The `/error` route demonstrates replying
 * with an HTTP error via `@fastify/sensible`.
 */
const example: FastifyPluginAsync = async (
  fastify: FastifyTypebox,
): Promise<void> => {
  fastify.get(
    "/",
    {
      schema: {
        summary: "Get Example",
        tags: ["Example"],
        response: {
          200: Type.String(),
        },
      },
    },
    async () => "this is an example",
  );

  fastify.get(
    "/error",
    {
      schema: {
        summary: "Get Example with Some Errors",
        tags: ["Example"],
        response: {
          400: HttpError,
        },
      },
    },
    async (_request, reply) => reply.badRequest("this is an error example"),
  );
};

export default example;
