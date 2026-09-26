import { isDeepStrictEqual } from "node:util";
import type { EventDocument } from "./model.js";

/** Delivery re-reads text and recipient details; only timing/preferences need jobs. */
export function reminderScheduleChanged(
  before: EventDocument,
  after: EventDocument,
): boolean {
  const timing = (event: EventDocument) => ({
    schedule: event.schedule,
    recurrence: event.recurrence,
    emailNotifications: event.emailNotifications,
    exceptions: (event.exceptions ?? [])
      .filter(
        (exception) =>
          exception.cancelled ||
          exception.patch.schedule ||
          exception.patch.emailNotifications,
      )
      .map((exception) =>
        exception.cancelled
          ? { originalStart: exception.originalStart, cancelled: true }
          : {
              originalStart: exception.originalStart,
              schedule: exception.patch.schedule,
              emailNotifications: exception.patch.emailNotifications,
            },
      )
      .sort((a, b) => a.originalStart.localeCompare(b.originalStart)),
  });
  return !isDeepStrictEqual(timing(before), timing(after));
}
