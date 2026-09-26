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

test("appointments default to reminders 24 hours and 2 hours before", () => {
  expect(applyCreateEventDefaults(appointment).emailNotifications).toEqual({
    enabled: true,
    minutesBefore: [1440, 120],
  });
});

const otherEventTypes: CreateEventInput["eventType"][] = [
  "class",
  "club",
  "study",
  "personal",
  "other",
];

test.each(otherEventTypes)(
  "%s events default to email disabled",
  (eventType) => {
    expect(
      applyCreateEventDefaults({ ...appointment, eventType })
        .emailNotifications,
    ).toEqual({ enabled: false });
  },
);

test("explicitly disabling email overrides the appointment default", () => {
  expect(
    applyCreateEventDefaults({
      ...appointment,
      emailNotifications: { enabled: false },
    }).emailNotifications,
  ).toEqual({ enabled: false });
});

test("explicitly enabling email on a class uses default timings", () => {
  expect(
    applyCreateEventDefaults({
      ...appointment,
      eventType: "class",
      emailNotifications: { enabled: true },
    }).emailNotifications,
  ).toEqual({ enabled: true, minutesBefore: [1440, 120] });
});

test("custom timings, including zero, override defaults without mutation", () => {
  const input: CreateEventInput = {
    ...appointment,
    emailNotifications: { enabled: true, minutesBefore: [60, 0] },
  };
  const before = structuredClone(input);
  const result = applyCreateEventDefaults(input);

  expect(result.emailNotifications).toEqual({
    enabled: true,
    minutesBefore: [60, 0],
  });
  if (result.emailNotifications.enabled) {
    result.emailNotifications.minutesBefore.push(30);
  }
  expect(input).toEqual(before);
});

test("default arrays are independent between events", () => {
  const first = applyCreateEventDefaults(appointment);
  if (first.emailNotifications.enabled) {
    first.emailNotifications.minutesBefore.push(30);
  }
  expect(applyCreateEventDefaults(appointment).emailNotifications).toEqual({
    enabled: true,
    minutesBefore: [1440, 120],
  });
  expect(appointment).not.toHaveProperty("emailNotifications");
});

test("all-day events allowing conflicts retain their details and reminder defaults", () => {
  const input: CreateEventInput = {
    ...appointment,
    description: "Annual checkup",
    location: "Campus clinic",
    allowConflicts: true,
    schedule: {
      kind: "all-day",
      startsOn: "2026-10-05",
      endsOn: "2026-10-06",
    },
    emailNotifications: { enabled: true },
  };
  const before = structuredClone(input);
  const result = applyCreateEventDefaults(input);

  expect<unknown>(result).toEqual({
    ...before,
    color: "#DC2626",
    emailNotifications: { enabled: true, minutesBefore: [1440, 120] },
  });
  expect(result).not.toBe(input);
  expect(input).toEqual(before);
});
