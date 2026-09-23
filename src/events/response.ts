import { type Static, Type } from "typebox";
import type { EventDocument } from "./model.js";
import { CreateEventSchema, EmailNotificationsSchema } from "./schemas.js";

export const EventResponseSchema = Type.Object(
  {
    ...CreateEventSchema.properties,
    // Enabled reminders always include resolved timings in responses.
    emailNotifications: Type.Union([
      EmailNotificationsSchema.anyOf[0],
      Type.Required(EmailNotificationsSchema.anyOf[1]),
    ]),
    id: Type.String({ pattern: "^[a-f0-9]{24}$" }),
    uid: Type.String(),
    revision: Type.Integer({ minimum: 1 }),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export type EventResponse = Static<typeof EventResponseSchema>;

export const EventListResponseSchema = Type.Object(
  {
    items: Type.Array(EventResponseSchema, { maxItems: 100 }),
    nextCursor: Type.Union([
      Type.String({ pattern: "^[a-f0-9]{24}$" }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export type EventListResponse = Static<typeof EventListResponseSchema>;

/** Explicit public fields prevent storage-only data from leaking into responses. */
export function toEventResponse(event: EventDocument): EventResponse {
  return {
    id: event._id.toHexString(),
    title: event.title,
    ...(event.description !== undefined
      ? { description: event.description }
      : {}),
    ...(event.location !== undefined ? { location: event.location } : {}),
    eventType: event.eventType,
    isOptional: event.isOptional,
    schedule:
      event.schedule.kind === "timed"
        ? {
            kind: "timed",
            startsAt: event.schedule.startsAt.toISOString(),
            endsAt: event.schedule.endsAt.toISOString(),
          }
        : {
            kind: "all-day",
            startsOn: event.schedule.startsOn,
            endsOn: event.schedule.endsOn,
          },
    emailNotifications: event.emailNotifications,
    uid: event.uid,
    revision: event.revision,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}
