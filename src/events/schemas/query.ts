import { type Static, Type } from "typebox";

export const CALENDAR_RANGE_MAX_DAYS = 93;

const ObjectIdStringSchema = Type.String({ pattern: "^[a-fA-F0-9]{24}$" });

export const EventIdParamsSchema = Type.Object(
  { id: ObjectIdStringSchema },
  { additionalProperties: false },
);

export const ListEventsQuerySchema = Type.Object(
  {
    from: Type.Optional(Type.String({ format: "date" })),
    to: Type.Optional(Type.String({ format: "date" })),
    // URL query values are strings; only explicit integer text is accepted.
    limit: Type.Optional(Type.String({ pattern: "^(?:[1-9][0-9]?|100)$" })),
    after: Type.Optional(
      Type.String({
        maxLength: 128,
        pattern: "^[a-fA-F0-9]{24}(?:~[0-9TZ:.\\-]+)?$",
      }),
    ),
  },
  { additionalProperties: false },
);

export type ListEventsQuery = Static<typeof ListEventsQuerySchema>;

/** Export has no pagination: it returns the whole selection or a size error. */
export const ExportEventsQuerySchema = Type.Pick(
  ListEventsQuerySchema,
  ["from", "to"],
  {
    additionalProperties: false,
  },
);
