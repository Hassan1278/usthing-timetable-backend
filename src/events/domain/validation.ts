import type { CreateEventInput } from "../schemas/event.js";

/** A business-rule failure that the HTTP layer can map to a 400 response. */
export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventValidationError";
  }
}

/**
 * Check a complete event after schema validation, including merged updates.
 * The timetable is fixed to Asia/Hong_Kong; offsets only identify instants.
 */
export function validateEvent(input: CreateEventInput): void {
  const { schedule } = input;

  if (schedule.kind === "timed") {
    const start = Date.parse(schedule.startsAt);
    const end = Date.parse(schedule.endsAt);
    if (!(end > start)) {
      throw new EventValidationError("endsAt must be after startsAt.");
    }
    return;
  }

  // Schema-validated YYYY-MM-DD strings sort in calendar order. These are
  // Hong Kong calendar dates, so no UTC conversion is needed.
  if (!(schedule.endsOn > schedule.startsOn)) {
    throw new EventValidationError("endsOn must be after startsOn.");
  }
}
