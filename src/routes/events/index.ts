import type { FastifyPluginAsync, FastifySchemaCompiler } from "fastify";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { FastifyTypebox } from "../../app.js";
import {
  MutationHeadersSchema,
  PatchEventSchema,
} from "../../events/mutation-schemas.js";
import {
  deleteEvent,
  EventRevisionError,
  updateEvent,
} from "../../events/mutations.js";
import {
  EventIdParamsSchema,
  ListEventsQuerySchema,
} from "../../events/query-schemas.js";
import {
  EventListResponseSchema,
  EventResponseSchema,
  toEventResponse,
} from "../../events/response.js";
import { CreateEventSchema } from "../../events/schemas.js";
import { createEvent, getEvent, listEvents } from "../../events/service.js";
import { EventValidationError } from "../../events/validation.js";
import { HttpError } from "../../plugins/sensible.js";

// Preserve strict schema behavior: no coercion, injected defaults or stripped fields.
const strictValidatorCompiler: FastifySchemaCompiler<TSchema> = ({
  schema,
}) => {
  const validator = Compile(schema);
  return (value) =>
    validator.Check(value) ? { value } : { error: validator.Errors(value) };
};

const events: FastifyPluginAsync = async (fastify: FastifyTypebox) => {
  fastify.withAuth(async (scope) => {
    scope.get(
      "/",
      {
        validatorCompiler: strictValidatorCompiler,
        schema: {
          summary: "List your non-recurring events",
          description:
            "Optional from/to dates bound a Hong Kong calendar range of at most 93 days. Pages are ordered by ID; limit defaults to 50 (maximum 100). Pass nextCursor as after with the same filters.",
          tags: ["Events"],
          security: [{ Auth: [] }],
          querystring: ListEventsQuerySchema,
          response: { 200: EventListResponseSchema, 400: HttpError },
        },
      },
      async (request, reply) => {
        try {
          const result = await listEvents(
            scope.collections.events,
            request.query,
            request.user.id,
          );
          return {
            items: result.events.map(toEventResponse),
            nextCursor: result.nextCursor,
          };
        } catch (error) {
          if (error instanceof EventValidationError) {
            return reply.badRequest(error.message);
          }
          throw error;
        }
      },
    );

    scope.get(
      "/:id",
      {
        validatorCompiler: strictValidatorCompiler,
        schema: {
          summary: "Get one of your events",
          tags: ["Events"],
          security: [{ Auth: [] }],
          params: EventIdParamsSchema,
          response: {
            200: EventResponseSchema,
            400: HttpError,
            404: HttpError,
          },
        },
      },
      async (request, reply) => {
        const event = await getEvent(
          scope.collections.events,
          request.params.id,
          request.user.id,
        );
        if (!event) return reply.notFound("Event not found.");
        return reply
          .header("ETag", `"${event.revision}"`)
          .send(toEventResponse(event));
      },
    );

    scope.post(
      "/",
      {
        validatorCompiler: strictValidatorCompiler,
        schema: {
          summary: "Create a custom timetable event",
          description:
            "Creates an event in the fixed Asia/Hong_Kong timetable.",
          tags: ["Events"],
          security: [{ Auth: [] }],
          body: CreateEventSchema,
          response: { 201: EventResponseSchema, 400: HttpError },
        },
      },
      async (request, reply) => {
        try {
          const event = await createEvent(
            scope.collections.events,
            request.body,
            request.user.id,
          );
          return reply
            .code(201)
            .header("ETag", `"${event.revision}"`)
            .send(toEventResponse(event));
        } catch (error) {
          if (error instanceof EventValidationError) {
            return reply.badRequest(error.message);
          }
          throw error;
        }
      },
    );

    scope.patch(
      "/:id",
      {
        validatorCompiler: strictValidatorCompiler,
        schema: {
          summary: "Update one of your events",
          description:
            'Requires If-Match with the current quoted revision, for example "1". Supplied nested objects replace previous settings; omitted fields stay unchanged.',
          tags: ["Events"],
          security: [{ Auth: [] }],
          params: EventIdParamsSchema,
          headers: MutationHeadersSchema,
          body: PatchEventSchema,
          response: {
            200: EventResponseSchema,
            400: HttpError,
            404: HttpError,
            412: HttpError,
            428: HttpError,
          },
        },
      },
      async (request, reply) => {
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
          const event = await updateEvent(
            scope.collections.events,
            request.params.id,
            request.user.id,
            revision,
            request.body,
          );
          if (!event) return reply.notFound("Event not found.");
          return reply
            .header("ETag", `"${event.revision}"`)
            .send(toEventResponse(event));
        } catch (error) {
          if (error instanceof EventValidationError)
            return reply.badRequest(error.message);
          if (error instanceof EventRevisionError)
            return reply.preconditionFailed(error.message);
          throw error;
        }
      },
    );

    scope.delete(
      "/:id",
      {
        validatorCompiler: strictValidatorCompiler,
        schema: {
          summary: "Delete one of your events",
          description:
            "Requires If-Match with the current quoted revision. Success returns 204 without a body.",
          tags: ["Events"],
          security: [{ Auth: [] }],
          params: EventIdParamsSchema,
          headers: MutationHeadersSchema,
          response: {
            204: { type: "null", description: "Event deleted" },
            400: HttpError,
            404: HttpError,
            412: HttpError,
            428: HttpError,
          },
        },
      },
      async (request, reply) => {
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
          const deleted = await deleteEvent(
            scope.collections.events,
            request.params.id,
            request.user.id,
            revision,
          );
          if (!deleted) return reply.notFound("Event not found.");
          return reply.code(204).send(null);
        } catch (error) {
          if (error instanceof EventRevisionError)
            return reply.preconditionFailed(error.message);
          throw error;
        }
      },
    );
  });
};

export default events;
