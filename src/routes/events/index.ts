import type { FastifyPluginAsync, FastifySchemaCompiler } from "fastify";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { FastifyTypebox } from "../../app.js";
import { EventResponseSchema, toEventResponse } from "../../events/response.js";
import { CreateEventSchema } from "../../events/schemas.js";
import { createEvent } from "../../events/service.js";
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
