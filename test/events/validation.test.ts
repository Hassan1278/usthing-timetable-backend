import { expect, test } from "bun:test";
import { Compile } from "typebox/compile";
import {
  EventValidationError,
  validateEvent,
} from "../../src/events/domain/validation.js";
import {
  type CreateEventInput,
  CreateEventSchema,
} from "../../src/events/schemas/event.js";

const validator = Compile(CreateEventSchema);

function event(schedule: CreateEventInput["schedule"]): CreateEventInput {
  return {
    title: "Study session",
    eventType: "study",
    allowConflicts: false,
    schedule,
  };
}

const validSchedules: CreateEventInput["schedule"][] = [
  {
    kind: "timed",
    startsAt: "2026-10-05T10:00:00+08:00",
    endsAt: "2026-10-05T11:00:00+08:00",
  },
  {
    kind: "timed",
    startsAt: "2026-10-05T23:30:00+08:00",
    endsAt: "2026-10-06T00:30:00+08:00",
  },
  {
    // 10:00 to 11:00 Hong Kong time, despite the end's smaller clock text.
    kind: "timed",
    startsAt: "2026-10-05T10:00:00+08:00",
    endsAt: "2026-10-05T03:00:00Z",
  },
  {
    // Past events are allowed.
    kind: "timed",
    startsAt: "2020-01-01T10:00:00+08:00",
    endsAt: "2020-01-01T11:00:00+08:00",
  },
  { kind: "all-day", startsOn: "2026-10-05", endsOn: "2026-10-06" },
  { kind: "all-day", startsOn: "2026-12-31", endsOn: "2027-01-02" },
];

test.each(validSchedules)(
  "accepts valid interval %# without mutation",
  (schedule) => {
    const input = event(schedule);
    const before = structuredClone(input);
    expect(validator.Check(input)).toBe(true);
    expect(() => validateEvent(input)).not.toThrow();
    expect(input).toEqual(before);
  },
);

const invalidSchedules: CreateEventInput["schedule"][] = [
  {
    kind: "timed",
    startsAt: "2026-10-05T10:00:00+08:00",
    endsAt: "2026-10-05T10:00:00+08:00",
  },
  {
    kind: "timed",
    startsAt: "2026-10-05T10:00:00+08:00",
    endsAt: "2026-10-05T09:00:00+08:00",
  },
  {
    // Different text, same instant: zero duration is invalid.
    kind: "timed",
    startsAt: "2026-10-05T10:00:00+08:00",
    endsAt: "2026-10-05T02:00:00Z",
  },
  {
    // The end's larger clock text still represents an earlier instant.
    kind: "timed",
    startsAt: "2026-10-05T03:00:00Z",
    endsAt: "2026-10-05T10:00:00+08:00",
  },
  { kind: "all-day", startsOn: "2026-10-05", endsOn: "2026-10-05" },
  { kind: "all-day", startsOn: "2026-10-05", endsOn: "2026-10-04" },
];

test.each(invalidSchedules)(
  "rejects invalid interval %# after schema validation",
  (schedule) => {
    const input = event(schedule);
    expect(validator.Check(input)).toBe(true);
    expect(() => validateEvent(input)).toThrow(EventValidationError);
    expect(() => validateEvent(input)).toThrow(
      schedule.kind === "timed"
        ? "endsAt must be after startsAt."
        : "endsOn must be after startsOn.",
    );
  },
);
