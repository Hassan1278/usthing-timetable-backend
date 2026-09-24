import { describe, expect, test } from "bun:test";
import { Compile } from "typebox/compile";
import { CreateEventSchema } from "../../src/events/schemas/event.js";

const validator = Compile(CreateEventSchema);

const validEvent = {
  title: "Doctor appointment",
  eventType: "appointment",
  allowConflicts: false,
  schedule: {
    kind: "timed",
    startsAt: "2026-10-05T10:00:00+08:00",
    endsAt: "2026-10-05T11:00:00+08:00",
  },
};

describe("event input", () => {
  test("accepts a timed event without optional fields", () => {
    expect(validator.Check(validEvent)).toBe(true);
  });

  test("accepts an all-day event", () => {
    expect(
      validator.Check({
        ...validEvent,
        schedule: {
          kind: "all-day",
          startsOn: "2026-10-05",
          endsOn: "2026-10-06",
        },
      }),
    ).toBe(true);
  });

  test("accepts UTC timestamps for the Hong Kong timetable", () => {
    expect(
      validator.Check({
        ...validEvent,
        schedule: {
          kind: "timed",
          startsAt: "2026-10-05T02:00:00Z",
          endsAt: "2026-10-05T03:00:00Z",
        },
      }),
    ).toBe(true);
  });

  test.each(["class", "appointment", "club", "study", "personal", "other"])(
    "accepts event type %s",
    (eventType) => {
      expect(validator.Check({ ...validEvent, eventType })).toBe(true);
    },
  );

  test.each(["title", "eventType", "allowConflicts", "schedule"])(
    "rejects a missing %s",
    (field) => {
      const input = Object.fromEntries(
        Object.entries(validEvent).filter(([key]) => key !== field),
      );
      expect(validator.Check(input)).toBe(false);
    },
  );

  test.each(["", "   ", "\t\n", "x".repeat(121)])(
    "rejects invalid title %j",
    (title) => {
      expect(validator.Check({ ...validEvent, title })).toBe(false);
    },
  );

  test("accepts text fields at their length limits", () => {
    expect(
      validator.Check({
        ...validEvent,
        title: "x".repeat(120),
        description: "x".repeat(2000),
        location: "x".repeat(200),
      }),
    ).toBe(true);
  });

  test.each([
    { description: "x".repeat(2001) },
    { location: "x".repeat(201) },
    { eventType: "unknown" },
    { allowConflicts: "false" },
    { isOptional: true },
  ])("rejects invalid event details %#", (changes) => {
    expect(validator.Check({ ...validEvent, ...changes })).toBe(false);
  });

  test.each([
    "ownerId",
    "_id",
    "id",
    "uid",
    "revision",
    "createdAt",
    "updatedAt",
    "exceptions",
  ])("rejects client-supplied %s", (field) => {
    expect(validator.Check({ ...validEvent, [field]: "untrusted" })).toBe(
      false,
    );
  });

  const invalidSchedules: unknown[] = [
    { ...validEvent.schedule, startsAt: "not-a-date" },
    { ...validEvent.schedule, endsAt: "2026-02-30T11:00:00+08:00" },
    { ...validEvent.schedule, startsAt: "2026-10-05T10:00:00" },
    { ...validEvent.schedule, timeZone: "Asia/Hong_Kong" },
    { ...validEvent.schedule, startsOn: "2026-10-05" },
    { kind: "timed", startsAt: validEvent.schedule.startsAt },
    { kind: "all-day", startsOn: "2026-02-30", endsOn: "2026-03-01" },
    { kind: "all-day", startsOn: "2026-10-05" },
    {
      kind: "all-day",
      startsOn: "2026-10-05",
      endsOn: "2026-10-06",
      timeZone: "Asia/Hong_Kong",
    },
  ];

  test.each(invalidSchedules)("rejects invalid schedule %#", (schedule) => {
    expect(validator.Check({ ...validEvent, schedule })).toBe(false);
  });
});

describe("email notification input", () => {
  test.each([
    { enabled: false },
    { enabled: true },
    { enabled: true, minutesBefore: [1440, 120] },
    { enabled: true, minutesBefore: [10080, 120, 0] },
  ])("accepts valid settings %#", (emailNotifications) => {
    expect(validator.Check({ ...validEvent, emailNotifications })).toBe(true);
  });

  test.each([
    {},
    { enabled: "true" },
    { enabled: false, minutesBefore: [120] },
    { enabled: true, minutesBefore: [] },
    { enabled: true, minutesBefore: [120, 120] },
    { enabled: true, minutesBefore: [-1] },
    { enabled: true, minutesBefore: [10081] },
    { enabled: true, minutesBefore: [1.5] },
    { enabled: true, minutesBefore: ["120"] },
    { enabled: true, minutesBefore: [1, 2, 3, 4] },
    { enabled: true, email: "other@example.com" },
  ])("rejects invalid settings %#", (emailNotifications) => {
    expect(validator.Check({ ...validEvent, emailNotifications })).toBe(false);
  });

  test("validation leaves omitted settings and timings untouched", () => {
    const input = { ...validEvent, emailNotifications: { enabled: true } };
    expect(validator.Check(input)).toBe(true);
    expect(input.emailNotifications).toEqual({ enabled: true });
    expect(validator.Check(validEvent)).toBe(true);
    expect(validEvent).not.toHaveProperty("emailNotifications");
  });
});
