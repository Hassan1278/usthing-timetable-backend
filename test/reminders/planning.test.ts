import { expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { EventDocument } from "../../src/events/domain/model.js";
import { loadReminderConfig } from "../../src/reminders/config.js";
import { LATE_GRACE_MS, planReminders } from "../../src/reminders/planning.js";

const now = Date.parse("2030-10-05T00:00:00Z");
function event(): EventDocument {
  return {
    _id: new ObjectId(),
    ownerId: "owner",
    uid: "uid",
    title: "Appointment",
    eventType: "appointment",
    allowConflicts: false,
    schedule: {
      kind: "timed",
      startsAt: new Date(now + 2 * 3600000),
      endsAt: new Date(now + 3 * 3600000),
    },
    emailNotifications: { enabled: true, minutesBefore: [1440, 120] },
    revision: 1,
    createdAt: new Date(now - 86400000),
    updatedAt: new Date(now - 86400000),
  };
}

test("plans only eligible reminders in a rolling window without recipient data", () => {
  const item = event();
  const jobs = planReminders(item, now);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.dueAt).toBe(now);
  expect(jobs[0]?.minutesBefore).toBe(120);
  expect(jobs[0]).not.toHaveProperty("email");
  expect(jobs[0]).not.toHaveProperty("title");
  expect(
    planReminders({ ...item, title: "Changed", revision: 2 }, now)[0]?.key,
  ).toBe(jobs[0]?.key);
  expect(planReminders({ ...item, createdAt: new Date(now + 1) }, now)).toEqual(
    [],
  );
  expect(
    planReminders({ ...item, emailNotifications: { enabled: false } }, now),
  ).toEqual([]);
});

test("recurrence applies cancellations and moves, including enabled overrides on disabled parents", () => {
  const item = event();
  item.recurrence = { frequency: "daily", endsOn: "2030-10-07" };
  item.emailNotifications = { enabled: false };
  item.exceptions = [
    {
      originalStart: "2030-10-06T02:00:00.000Z",
      cancelled: false,
      patch: {
        emailNotifications: { enabled: true, minutesBefore: [60] },
        schedule: {
          kind: "timed",
          startsAt: "2030-10-05T04:00:00Z",
          endsAt: "2030-10-05T05:00:00Z",
        },
      },
    },
  ];
  expect(planReminders(item, now)).toHaveLength(1);
  expect(planReminders(item, now)[0]?.originalStart).toBe(
    "2030-10-06T02:00:00.000Z",
  );
  expect(planReminders(item, now)[0]?.dueAt).toBe(now + 3 * 3600000);
  item.exceptions = [
    { originalStart: "2030-10-06T02:00:00.000Z", cancelled: true },
  ];
  expect(planReminders(item, now)).toEqual([]);
});

test("all-day reminders use HK midnight and overdue jobs have a bounded grace", () => {
  const item = event();
  item.schedule = {
    kind: "all-day",
    startsOn: "2030-10-06",
    endsOn: "2030-10-07",
  };
  item.emailNotifications = { enabled: true, minutesBefore: [0] };
  const due = Date.parse("2030-10-05T16:00:00Z");
  expect(planReminders(item, now)[0]?.dueAt).toBe(due);
  expect(planReminders(item, due + LATE_GRACE_MS)).toHaveLength(1);
  expect(planReminders(item, due + LATE_GRACE_MS + 1)).toHaveLength(0);
});

test("worker configuration requires deliberate enablement and valid SMTP settings", () => {
  const env = {
    EMAIL_DELIVERY_ENABLED: "true",
    MONGO_URI: "mongodb://localhost/test",
    SMTP_HOST: "127.0.0.1",
  };
  expect(loadReminderConfig(env).mail.port).toBe(1025);
  for (const override of [
    { EMAIL_DELIVERY_ENABLED: "false" },
    { MONGO_URI: "" },
    { SMTP_HOST: "" },
    { SMTP_PORT: "1.5" },
    { SMTP_PORT: "65536" },
    { SMTP_SECURE: "yes" },
    { SMTP_FROM: "invalid" },
    { SMTP_USER: "user" },
  ])
    expect(() => loadReminderConfig({ ...env, ...override })).toThrow();
});
