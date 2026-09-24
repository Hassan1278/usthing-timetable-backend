import { type Static, Type } from "typebox";
import { CreateEventSchema } from "./event.js";

// Nested schedule, recurrence and email objects are replacements, not deep partial updates.
export const PatchEventSchema = Type.Object(
  {
    ...Type.Partial(CreateEventSchema).properties,
    recurrence: Type.Optional(
      Type.Union([CreateEventSchema.properties.recurrence, Type.Null()]),
    ),
    clearExceptions: Type.Optional(Type.Literal(true)),
  },
  { minProperties: 1, additionalProperties: false },
);
export type PatchEventInput = Static<typeof PatchEventSchema>;

export const MutationHeadersSchema = Type.Object({
  "if-match": Type.Optional(Type.String({ pattern: '^"[1-9][0-9]{0,15}"$' })),
});
