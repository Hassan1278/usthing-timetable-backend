import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";

/** Readiness includes database connectivity without exposing configuration. */
const health: FastifyPluginAsync = async (app: FastifyTypebox) => {
  app.get(
    "/",
    {
      schema: {
        summary: "Check API and database readiness",
        response: {
          200: Type.Object({ status: Type.Literal("ok") }),
          503: Type.Object({ status: Type.Literal("unavailable") }),
        },
      },
    },
    async (_request, reply) => {
      const db = app.mongo?.db;
      if (!db) return reply.code(503).send({ status: "unavailable" });
      try {
        await db.command({ ping: 1 }, { timeoutMS: 2000 });
        return { status: "ok" as const };
      } catch {
        return reply.code(503).send({ status: "unavailable" });
      }
    },
  );
};

export default health;
