import { expect, test } from "bun:test";
import { Compile } from "typebox/compile";
import { EventValidationError } from "../../src/events/domain/validation.js";
import { resolveRecurrence } from "../../src/events/recurrence/defaults.js";
import {
  type CreateEventInput,
  CreateEventSchema,
} from "../../src/events/schemas/event.js";
import { PatchEventSchema } from "../../src/events/schemas/mutation.js";
import {
  type RecurrenceInput,
  RecurrenceSchema,
} from "../../src/events/schemas/recurrence.js";

const eventValidator = Compile(CreateEventSchema);
const recurrenceValidator = Compile(RecurrenceSchema);
const patchValidator = Compile(PatchEventSchema);
const timed: CreateEventInput["schedule"] = {
  kind: "timed",
  startsAt: "2026-10-05T10:00:00+08:00",
  endsAt: "2026-10-05T11:00:00+08:00",
};
const allDay: CreateEventInput["schedule"] = {
  kind: "all-day",
  startsOn: "2026-10-05",
  endsOn: "2026-10-07",
};
const base = { title: "Club", eventType: "club", allowConflicts: false };

for (const schedule of [timed, allDay]) {
  test(`${schedule.kind} event remains valid without recurrence`, () => {
    const input = { ...base, schedule };
    expect(eventValidator.Check(input)).toBe(true);
    expect(resolveRecurrence(schedule, undefined)).toBeUndefined();
    expect(input).not.toHaveProperty("recurrence");
  });
  for (const frequency of ["daily", "weekly"] as const) {
    test(`${schedule.kind} ${frequency} recurrence accepts an omitted or explicit end`, () => {
      for (const recurrence of [
        { frequency },
        { frequency, endsOn: "2027-05-31" },
      ]) {
        const input = { ...base, schedule, recurrence };
        const before = structuredClone(input);
        expect(eventValidator.Check(input)).toBe(true);
        expect(patchValidator.Check({ recurrence })).toBe(true);
        expect(input).toEqual(before);
      }
      expect(resolveRecurrence(schedule, { frequency })).toEqual({
        frequency,
        endsOn: "2027-10-05",
      });
    });
  }
}

const invalidRecurrences = [
  null,
  false,
  "daily",
  [],
  {},
  { frequency: "monthly" },
  { frequency: "yearly" },
  { frequency: "DAILY" },
  { frequency: 1 },
  { endsOn: "2027-01-01" },
  { frequency: "daily", endsOn: null },
  { frequency: "daily", endsOn: "" },
  { frequency: "daily", endsOn: "2027-02-29" },
  { frequency: "daily", endsOn: "2027-04-31" },
  { frequency: "daily", endsOn: "2027-01-01T00:00:00Z" },
  { frequency: "daily", endsOn: 20270101 },
  { frequency: "daily", interval: 2 },
  { frequency: "weekly", weekdays: [1, 3] },
  { frequency: "daily", count: 10 },
  { frequency: "weekly", timeZone: "Asia/Hong_Kong" },
  { frequency: "weekly", exceptions: [] },
];
test.each(invalidRecurrences.map((recurrence) => ({ recurrence })))(
  "rejects invalid or unsupported recurrence %# without coercion",
  ({ recurrence }) => {
    const input = { ...base, schedule: timed, recurrence };
    const before = structuredClone(input);
    expect(recurrenceValidator.Check(recurrence)).toBe(false);
    expect(eventValidator.Check(input)).toBe(false);
    expect(patchValidator.Check({ recurrence })).toBe(recurrence === null);
    expect(input).toEqual(before);
  },
);

test("recurrence does not replace the normal event schedule or relax validation", () => {
  expect(
    eventValidator.Check({ ...base, recurrence: { frequency: "daily" } }),
  ).toBe(false);
  expect(
    eventValidator.Check({
      ...base,
      recurrence: { frequency: "daily" },
      schedule: { ...timed, startsAt: "2026-02-30T10:00:00Z" },
    }),
  ).toBe(false);
  expect(
    eventValidator.Check({
      ...base,
      recurrence: { frequency: "daily" },
      schedule: { ...allDay, timeZone: "UTC" },
    }),
  ).toBe(false);
});

test("resolved end is explicit and independent of the input", () => {
  const rule: RecurrenceInput = { frequency: "weekly" };
  const result = resolveRecurrence(allDay, rule);
  expect(result).toEqual({ frequency: "weekly", endsOn: "2027-10-05" });
  expect(rule).toEqual({ frequency: "weekly" });
  if (result) result.endsOn = "2026-11-01";
  expect(resolveRecurrence(allDay, rule)?.endsOn).toBe("2027-10-05");
});

test.each(["2026-10-05", "2027-05-31", "2027-10-05"])(
  "preserves valid inclusive recurrence end %s",
  (endsOn) => {
    expect(resolveRecurrence(allDay, { frequency: "daily", endsOn })).toEqual({
      frequency: "daily",
      endsOn,
    });
  },
);

test.each(["2026-10-04", "2027-10-06"])(
  "rejects out-of-range recurrence end %s after structural validation",
  (endsOn) => {
    const rule = { frequency: "weekly" as const, endsOn };
    expect(recurrenceValidator.Check(rule)).toBe(true);
    expect(() => resolveRecurrence(timed, rule)).toThrow(EventValidationError);
    expect(() => resolveRecurrence(allDay, rule)).toThrow(EventValidationError);
  },
);

test.each([
  ["2026-12-31T16:30:00Z", "2028-01-01"],
  ["2027-01-01T00:30:00+08:00", "2028-01-01"],
  ["2027-01-01T00:30:00+14:00", "2027-12-31"],
])("uses the Hong Kong start date for %s", (startsAt, expected) => {
  expect(
    resolveRecurrence(
      { kind: "timed", startsAt, endsAt: "2027-01-02T00:00:00Z" },
      { frequency: "daily" },
    )?.endsOn,
  ).toBe(expected);
});

test.each([
  ["2028-02-29", "2029-02-28"],
  ["2027-02-28", "2028-02-28"],
  ["2026-01-31", "2027-01-31"],
  ["2026-12-31", "2027-12-31"],
  ["2020-01-01", "2021-01-01"],
])(
  "adds calendar months rather than a fixed day count to %s",
  (startsOn, expected) => {
    const schedule = {
      kind: "all-day" as const,
      startsOn,
      endsOn: "2030-01-01",
    };
    expect(resolveRecurrence(schedule, { frequency: "weekly" })?.endsOn).toBe(
      expected,
    );
  },
);

test("end limits refer to occurrence starts, not the first occurrence's finish", () => {
  expect(
    resolveRecurrence(allDay, { frequency: "daily", endsOn: "2026-10-05" })
      ?.endsOn,
  ).toBe("2026-10-05");
});

test("leap-day default is also the maximum allowed end", () => {
  const schedule = {
    kind: "all-day" as const,
    startsOn: "2028-02-29",
    endsOn: "2028-03-01",
  };
  expect(() =>
    resolveRecurrence(schedule, { frequency: "weekly", endsOn: "2029-03-01" }),
  ).toThrow(EventValidationError);
});

test("rejects recurrence whose default date exceeds the supported year range", () => {
  expect(() =>
    resolveRecurrence(
      { kind: "all-day", startsOn: "9999-01-01", endsOn: "9999-01-02" },
      { frequency: "daily" },
    ),
  ).toThrow(EventValidationError);
});
