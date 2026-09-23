import type { FastifyPluginAsync, FastifySchemaCompiler } from "fastify";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { FastifyTypebox } from "../../app.js";
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
        return toEventResponse(event);
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
          return reply.code(201).send(toEventResponse(event));
        } catch (error) {
          if (error instanceof EventValidationError) {
            return reply.badRequest(error.message);
          }
          throw error;
        }
      },
    );
  });
};

export default events;
