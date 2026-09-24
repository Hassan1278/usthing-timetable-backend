import { type Static, Type } from "typebox";
import { RecurrenceSchema } from "./recurrence.js";

/** Validates input; the event service resolves omitted timings when enabled. */
export const EmailNotificationsSchema = Type.Union([
  Type.Object(
    { enabled: Type.Literal(false) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      enabled: Type.Literal(true),
      minutesBefore: Type.Optional(
        Type.Array(Type.Integer({ minimum: 0, maximum: 10080 }), {
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          description:
            "Minutes before the event. Omit for reminders 24 hours and 2 hours before; 0 means at the start.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
]);

export const TimedScheduleSchema = Type.Object(
  {
    kind: Type.Literal("timed"),
    startsAt: Type.String({ format: "date-time" }),
    endsAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export const AllDayScheduleSchema = Type.Object(
  {
    kind: Type.Literal("all-day"),
    startsOn: Type.String({ format: "date" }),
    endsOn: Type.String({ format: "date" }),
  },
  { additionalProperties: false },
);

export const ScheduleSchema = Type.Union([
  TimedScheduleSchema,
  AllDayScheduleSchema,
]);

export const EventTypeSchema = Type.Union([
  Type.Literal("class"),
  Type.Literal("appointment"),
  Type.Literal("club"),
  Type.Literal("study"),
  Type.Literal("personal"),
  Type.Literal("other"),
]);

export const CreateEventSchema = Type.Object(
  {
    title: Type.String({
      minLength: 1,
      maxLength: 120,
      pattern: "\\S",
    }),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    location: Type.Optional(Type.String({ maxLength: 200 })),

    eventType: EventTypeSchema,
    allowConflicts: Type.Boolean({
      description:
        "Allow this event to overlap other events. False rejects overlapping creates or updates.",
    }),
    schedule: ScheduleSchema,
    recurrence: Type.Optional(RecurrenceSchema),
    emailNotifications: Type.Optional(EmailNotificationsSchema),
  },
  { additionalProperties: false },
);

export type EmailNotificationsInput = Static<typeof EmailNotificationsSchema>;
export type CreateEventInput = Static<typeof CreateEventSchema>;
