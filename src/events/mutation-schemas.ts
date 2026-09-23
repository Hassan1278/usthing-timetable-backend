import { type Static, Type } from "typebox";
import { CreateEventSchema } from "./schemas.js";

// Nested schedule and email objects are replacements, not deep partial updates.
export const PatchEventSchema = Type.Partial(CreateEventSchema, {
  minProperties: 1,
});
export type PatchEventInput = Static<typeof PatchEventSchema>;

export const MutationHeadersSchema = Type.Object({
  "if-match": Type.Optional(Type.String({ pattern: '^"[1-9][0-9]{0,15}"$' })),
});
