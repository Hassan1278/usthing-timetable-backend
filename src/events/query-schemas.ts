import { type Static, Type } from "typebox";

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
    after: Type.Optional(ObjectIdStringSchema),
  },
  { additionalProperties: false },
);

export type ListEventsQuery = Static<typeof ListEventsQuerySchema>;
