import { createHash } from "node:crypto";
import type { EventDocument } from "../events/domain/model.js";
import { expandEvent, interval } from "../events/recurrence/series.js";

export const PLAN_WINDOW_MS = 24 * 60 * 60 * 1000;
export const LATE_GRACE_MS = 10 * 60 * 1000;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const SEND_JOB = "send-event-reminder";
export const PLAN_JOB = "plan-event-reminders";

/** No recipient or event text is copied into queue data. */
export type Reminder = {
  key: string;
  eventId: string;
  ownerId: string;
  originalStart: string;
  startsAt: number;
  minutesBefore: number;
  dueAt: number;
  expiresAt: Date;
  outcome?: "sent" | "skipped";
};

export function reminderFor(
  event: EventDocument,
  originalStart: string,
  startsAt: number,
  minutesBefore: number,
): Reminder {
  const eventId = event._id.toHexString();
  const dueAt = startsAt - minutesBefore * 60_000;
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        event.ownerId,
        eventId,
        originalStart,
        startsAt,
        minutesBefore,
      ]),
    )
    .digest("hex");
  return {
    key,
    eventId,
    ownerId: event.ownerId,
    originalStart,
    startsAt,
    minutesBefore,
    dueAt,
    expiresAt: new Date(dueAt + RETENTION_MS),
  };
}

/** Bounded lookahead with catch-up; never backfill reminders preceding creation. */
export function planReminders(event: EventDocument, now: number): Reminder[] {
  return expandEvent(event).flatMap((occurrence) => {
    const settings = occurrence.emailNotifications;
    if (!settings.enabled) return [];
    const startsAt = interval(occurrence.schedule).start;
    const originalStart =
      occurrence.originalStart ??
      (occurrence.schedule.kind === "timed"
        ? occurrence.schedule.startsAt.toISOString()
        : occurrence.schedule.startsOn);
    return settings.minutesBefore
      .map((minutes) => reminderFor(event, originalStart, startsAt, minutes))
      .filter(
        (reminder) =>
          reminder.dueAt >= event.createdAt.getTime() &&
          reminder.dueAt >= now - LATE_GRACE_MS &&
          reminder.dueAt <= now + PLAN_WINDOW_MS &&
          (reminder.minutesBefore === 0
            ? startsAt >= now - LATE_GRACE_MS
            : startsAt > now),
      );
  });
}
