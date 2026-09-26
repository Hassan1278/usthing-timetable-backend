import { type Static, Type } from "typebox";
import { CreateEventSchema } from "./event.js";

export const OriginalStartSchema = Type.Union([
  Type.String({ format: "date" }),
  Type.String({ format: "date-time" }),
]);
export const OccurrenceQuerySchema = Type.Object(
  { originalStart: OriginalStartSchema },
  { additionalProperties: false },
);
export const OccurrencePatchSchema = Type.Partial(
  Type.Pick(CreateEventSchema, [
    "title",
    "description",
    "location",
    "eventType",
    "color",
    "schedule",
    "emailNotifications",
  ]),
  { additionalProperties: false, minProperties: 1 },
);
export type OccurrencePatch = Static<typeof OccurrencePatchSchema>;
export const ExceptionSchema = Type.Union([
  Type.Object(
    { originalStart: OriginalStartSchema, cancelled: Type.Literal(true) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      originalStart: OriginalStartSchema,
      cancelled: Type.Literal(false),
      patch: OccurrencePatchSchema,
    },
    { additionalProperties: false },
  ),
]);
export type EventException = Static<typeof ExceptionSchema>;
