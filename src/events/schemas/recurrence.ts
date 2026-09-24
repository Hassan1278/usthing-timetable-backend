import { type Static, Type } from "typebox";

/** Optional on an event; schedule still defines the first start and duration. */
export const RecurrenceSchema = Type.Object(
  {
    frequency: Type.Union([Type.Literal("daily"), Type.Literal("weekly")]),
    endsOn: Type.Optional(
      Type.String({
        format: "date",
        description:
          "Inclusive last occurrence start date in Hong Kong. Omit for 12 calendar months after the first start; later dates are rejected by business validation.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Stored rules must contain the end resolved at creation, never a sliding default. */
export const ResolvedRecurrenceSchema = Type.Required(RecurrenceSchema, {
  additionalProperties: false,
});

export type RecurrenceInput = Static<typeof RecurrenceSchema>;
export type ResolvedRecurrence = Required<RecurrenceInput>;
