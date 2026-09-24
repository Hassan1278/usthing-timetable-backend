import { expect, test } from "bun:test";
import { applyCreateEventDefaults } from "../../src/events/domain/defaults.js";
import type { CreateEventInput } from "../../src/events/schemas/event.js";

const appointment: CreateEventInput = {
  title: "Doctor appointment",
  eventType: "appointment",
  allowConflicts: false,
  schedule: {
    kind: "timed",
    startsAt: "2026-10-05T10:00:00+08:00",
    endsAt: "2026-10-05T11:00:00+08:00",
  },
};

test.each([
  "class",
  "appointment",
  "club",
  "study",
  "personal",
  "other",
] as const)("%s defaults to email disabled", (eventType) => {
  const input = { ...appointment, eventType };
  const before = structuredClone(input);
  expect(applyCreateEventDefaults(input).emailNotifications).toEqual({
    enabled: false,
  });
  expect(input).toEqual(before);
});

test.each([
  { enabled: true as const },
  { enabled: true as const, minutesBefore: [60, 0] },
])("rejects enabling unfinished email delivery %#", (emailNotifications) => {
  expect(() =>
    applyCreateEventDefaults({
      ...appointment,
      emailNotifications: {
        enabled: true,
        ...(emailNotifications.minutesBefore
          ? { minutesBefore: [...emailNotifications.minutesBefore] }
          : {}),
      },
    }),
  ).toThrow("Email notifications are not available yet");
});

test("all-day events retain details while defaulting to email off", () => {
  const input: CreateEventInput = {
    ...appointment,
    schedule: { kind: "all-day", startsOn: "2026-10-05", endsOn: "2026-10-06" },
    emailNotifications: { enabled: false },
  };
  const before = structuredClone(input);
  expect<unknown>(applyCreateEventDefaults(input)).toEqual(before);
  expect(input).toEqual(before);
});
