import { Compile } from "typebox/compile";
import { resolveEmailNotifications } from "./defaults.js";
import type { EventDocument, StoredSchedule } from "./model.js";
import { generateAllOccurrences } from "./occurrences.js";
import { type CreateEventInput, CreateEventSchema } from "./schemas.js";
import { EventValidationError, validateEvent } from "./validation.js";

const inputValidator = Compile(CreateEventSchema);
export class CalendarCapacityError extends Error {
  readonly statusCode = 413;
  constructor() {
    super(
      "Calendar processing limit exceeded. Narrow the selection or reduce stored events.",
    );
  }
}
export const MAX_SCANNED_EVENTS = 1000;
export const MAX_EXPANDED_OCCURRENCES = 100000;

export function inputSchedule(
  schedule: StoredSchedule,
): CreateEventInput["schedule"] {
  return schedule.kind === "timed"
    ? {
        kind: "timed",
        startsAt: schedule.startsAt.toISOString(),
        endsAt: schedule.endsAt.toISOString(),
      }
    : { ...schedule };
}
export function storedSchedule(
  schedule: CreateEventInput["schedule"],
): StoredSchedule {
  return schedule.kind === "timed"
    ? {
        kind: "timed",
        startsAt: new Date(schedule.startsAt),
        endsAt: new Date(schedule.endsAt),
      }
    : { ...schedule };
}
export function eventInput(event: EventDocument): CreateEventInput {
  return {
    title: event.title,
    eventType: event.eventType,
    allowConflicts: event.allowConflicts,
    schedule: inputSchedule(event.schedule),
    emailNotifications: event.emailNotifications,
    ...(event.description !== undefined
      ? { description: event.description }
      : {}),
    ...(event.location !== undefined ? { location: event.location } : {}),
    ...(event.recurrence ? { recurrence: event.recurrence } : {}),
  };
}
export function baseOccurrences(
  event: Pick<EventDocument, "schedule" | "recurrence">,
) {
  return generateAllOccurrences({
    schedule: inputSchedule(event.schedule),
    ...(event.recurrence ? { recurrence: event.recurrence } : {}),
  });
}
export type ExpandedEvent = EventDocument & { originalStart?: string };

/** Apply exceptions before range filtering or conflict checks, including moved-in instances. */
export function expandEvent(
  event: EventDocument,
  budget?: { remaining: number },
): ExpandedEvent[] {
  const occurrences = baseOccurrences(event);
  if (budget) {
    budget.remaining -= occurrences.length;
    if (budget.remaining < 0) throw new CalendarCapacityError();
  }
  const exceptions = new Map(
    (event.exceptions ?? []).map((item) => [item.originalStart, item]),
  );
  if (
    exceptions.size !== (event.exceptions?.length ?? 0) ||
    exceptions.size > 367 ||
    [...exceptions.keys()].some(
      (key) => !occurrences.some((item) => item.originalStart === key),
    ) ||
    (!event.recurrence && exceptions.size)
  )
    throw new EventValidationError(
      "Stored exceptions do not match the series.",
    );
  const base = eventInput(event);
  return occurrences.flatMap((occurrence) => {
    const exception = exceptions.get(occurrence.originalStart);
    if (exception?.cancelled) return [];
    const candidate = {
      ...base,
      schedule: occurrence.schedule,
      ...(exception ? exception.patch : {}),
    };
    if (!inputValidator.Check(candidate))
      throw new EventValidationError("Invalid occurrence override.");
    validateEvent(candidate);
    if (candidate.schedule.kind !== event.schedule.kind)
      throw new EventValidationError(
        "An occurrence must keep its series schedule kind.",
      );
    return [
      {
        ...event,
        ...candidate,
        recurrence: event.recurrence,
        schedule: storedSchedule(candidate.schedule),
        emailNotifications: resolveEmailNotifications(
          candidate.emailNotifications ?? event.emailNotifications,
        ),
        ...(event.recurrence
          ? { originalStart: occurrence.originalStart }
          : {}),
      },
    ];
  });
}
export function interval(schedule: StoredSchedule): {
  start: number;
  end: number;
} {
  return schedule.kind === "timed"
    ? { start: schedule.startsAt.getTime(), end: schedule.endsAt.getTime() }
    : {
        start: Date.parse(`${schedule.startsOn}T00:00:00+08:00`),
        end: Date.parse(`${schedule.endsOn}T00:00:00+08:00`),
      };
}
export function overlapsRange(
  event: EventDocument,
  from: string,
  to: string,
): boolean {
  const { start, end } = interval(event.schedule);
  return (
    start < Date.parse(`${to}T00:00:00+08:00`) &&
    end > Date.parse(`${from}T00:00:00+08:00`)
  );
}
