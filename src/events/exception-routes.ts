import type { FastifySchemaCompiler } from "fastify";
import type { TSchema } from "typebox";
import type { FastifyTypebox } from "../app.js";
import type { AuthUser } from "../plugins/auth.js";
import { HttpError } from "../plugins/sensible.js";
import { EventConflictError } from "./conflicts.js";
import {
  OccurrencePatchSchema,
  OccurrenceQuerySchema,
} from "./exception-schema.js";
import { changeOccurrence } from "./exception-service.js";
import { MutationHeadersSchema } from "./mutation-schemas.js";
import { EventRevisionError } from "./mutations.js";
import { EventIdParamsSchema } from "./query-schemas.js";
import { EventResponseSchema, toEventResponse } from "./response.js";
import { EventValidationError } from "./validation.js";

/** Register inside the existing authenticated event scope. */
export function registerExceptionRoutes(
  scope: FastifyTypebox,
  validatorCompiler: FastifySchemaCompiler<TSchema>,
) {
  for (const action of ["edit", "cancel", "restore"] as const) {
    scope.route({
      method:
        action === "edit" ? "PATCH" : action === "cancel" ? "DELETE" : "POST",
      url:
        action === "restore" ? "/:id/occurrences/restore" : "/:id/occurrences",
      validatorCompiler,
      schema: {
        summary: `${action} one occurrence using its original start`,
        description:
          "Requires the parent series If-Match revision. Returns the updated series and ETag; originalStart remains unchanged when an occurrence moves.",
        tags: ["Events"],
        security: [{ Auth: [] }],
        params: EventIdParamsSchema,
        querystring: OccurrenceQuerySchema,
        headers: MutationHeadersSchema,
        ...(action === "edit" ? { body: OccurrencePatchSchema } : {}),
        response: {
          200: EventResponseSchema,
          400: HttpError,
          404: HttpError,
          409: HttpError,
          412: HttpError,
          413: HttpError,
          428: HttpError,
        },
      },
      handler: async (request, reply) => {
        const match = request.headers["if-match"];
        if (match === undefined)
          return reply.preconditionRequired(
            "Supply If-Match with the current event revision.",
          );
        const revision = Number(match.slice(1, -1));
        if (
          !Number.isSafeInteger(revision) ||
          revision >= Number.MAX_SAFE_INTEGER
        )
          return reply.badRequest("Invalid event revision.");
        try {
          const event = await changeOccurrence(
            scope.collections.events,
            request.params.id,
            request.getDecorator<AuthUser>("user").id,
            revision,
            request.query.originalStart,
            action,
            request.body,
          );
          if (!event) return reply.notFound("Event or occurrence not found.");
          return reply
            .header("ETag", `"${event.revision}"`)
            .send(toEventResponse(event));
        } catch (error) {
          if (error instanceof EventConflictError)
            return reply.conflict(error.message);
          if (error instanceof EventValidationError)
            return reply.badRequest(error.message);
          if (error instanceof EventRevisionError)
            return reply.preconditionFailed(error.message);
          throw error;
        }
      },
    });
  }
}
