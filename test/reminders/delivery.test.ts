import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { ObjectId } from "mongodb";
import { SMTPServer } from "smtp-server";
import App from "../../src/app.js";
import { users } from "../../src/auth/users.js";
import { createMailer } from "../../src/reminders/mail.js";
import { SEND_JOB } from "../../src/reminders/planning.js";
import {
  createReminderScheduler,
  JOB_COLLECTION,
} from "../../src/reminders/scheduler.js";

const app = Fastify({ pluginTimeout: 300000 });
const messages: { text: string; to: string }[] = [];
let failures = 0;
let attempts = 0;
let failureCode = 451;
const server = new SMTPServer({
  disabledCommands: ["AUTH", "STARTTLS"],
  onData(stream, session, callback) {
    let text = "";
    stream.on("data", (chunk) => {
      text += chunk.toString();
    });
    stream.on("end", () => {
      attempts++;
      if (failures > 0) {
        failures--;
        return callback(
          Object.assign(new Error("Try again later"), {
            responseCode: failureCode,
          }),
        );
      }
      messages.push({ text, to: session.envelope.rcptTo[0]!.address });
      callback();
    });
  },
});
let mailer: ReturnType<typeof createMailer>;
let workers: Awaited<ReturnType<typeof createReminderScheduler>>[] = [];
beforeAll(async () => {
  await app.register(fp(App), {
    test: true,
    mongoUri: undefined,
    mongoTestUri: undefined,
    authSkip: false,
    rateLimitIpMax: 10000,
    rateLimitReadMax: 10000,
    rateLimitWriteMax: 10000,
  });
  await app.ready();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address() as AddressInfo;
  mailer = createMailer({
    host: "127.0.0.1",
    port: address.port,
    secure: false,
    from: "reminders@usthing.invalid",
  });
});
afterEach(async () => {
  for (const worker of workers) await worker.stop();
  workers = [];
});
afterAll(async () => {
  mailer.close();
  await new Promise<void>((resolve) => server.close(resolve));
  await app.close();
});
beforeEach(async () => {
  messages.length = 0;
  failures = 0;
  attempts = 0;
  failureCode = 451;
  await app.collections.events.deleteMany({});
  await app.mongo.db!.collection(JOB_COLLECTION).deleteMany({});
});
async function worker(send = mailer.send) {
  const result = await createReminderScheduler(app.mongo.db!, send, {
    processEveryMs: 50,
    retryDelayMs: 50,
  });
  workers.push(result);
  return result;
}
async function waitFor(condition: () => boolean | Promise<boolean>) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (await condition()) return;
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for reminder processing");
}
async function create(dueInMs = 300, extra: object = {}) {
  const start = Date.now() + 60000 + dueInMs;
  const response = await app.inject({
    method: "POST",
    url: "/events",
    headers: { authorization: "Bearer alice-dev-token" },
    payload: {
      title: "Private appointment",
      eventType: "appointment",
      allowConflicts: true,
      schedule: {
        kind: "timed",
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 3600000).toISOString(),
      },
      emailNotifications: { enabled: true, minutesBefore: [1] },
      ...extra,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}
const jobs = () => app.mongo.db!.collection(JOB_COLLECTION);

test("Agenda and Nodemailer deliver through SMTP after worker restart without duplicate planning", async () => {
  const event = await create(1500);
  const first = await worker();
  await first.reconcile();
  await first.reconcile();
  expect(await jobs().countDocuments({ name: SEND_JOB })).toBe(1);
  await first.start();
  await first.stop();
  workers = [];
  const second = await worker();
  await second.start();
  await waitFor(() => messages.length === 1);
  await waitFor(
    async () =>
      (await jobs().findOne({ name: SEND_JOB }))?.data.outcome === "sent",
  );
  expect(messages[0]?.to).toBe(users[0]!.email);
  expect(messages[0]?.text).toContain("Hong Kong");
  expect(messages[0]?.text).toContain(event.title);
  expect(messages[0]?.text).not.toContain("alice-dev-token");
  await second.reconcile();
  expect(await jobs().countDocuments({ name: SEND_JOB })).toBe(1);
  expect(
    (await app.collections.events.findOne({ _id: new ObjectId(event.id) }))
      ?.remindersPending,
  ).toBe(false);
});

test("SMTP temporary failure retries; two workers do not deliver the same job twice", async () => {
  failures = 1;
  await create();
  const first = await worker();
  await first.reconcile();
  const second = await worker();
  await first.start();
  await second.start();
  await waitFor(
    async () =>
      (await jobs().findOne({ name: SEND_JOB }))?.data.outcome === "sent",
  );
  expect(messages).toHaveLength(1);
  expect(attempts).toBe(2);
  await waitFor(() => first.isReady());
  expect(await second.isReady()).toBe(true);
});

test.each(["disable", "delete", "move", "cancel"] as const)(
  "%s invalidates a queued reminder before SMTP",
  async (action) => {
    const event = await create(
      300,
      action === "cancel" ? { recurrence: { frequency: "daily" } } : {},
    );
    const runner = await worker();
    await runner.reconcile();
    const headers = {
      authorization: "Bearer alice-dev-token",
      "if-match": '"1"',
    };
    if (action === "delete") {
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/events/${event.id}`,
            headers,
          })
        ).statusCode,
      ).toBe(204);
    } else if (action === "cancel") {
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/events/${event.id}/occurrences?originalStart=${encodeURIComponent(event.schedule.startsAt)}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
    } else {
      const change =
        action === "disable"
          ? { emailNotifications: { enabled: false } }
          : {
              schedule: {
                kind: "timed",
                startsAt: new Date(Date.now() + 3 * 86400000).toISOString(),
                endsAt: new Date(
                  Date.now() + 3 * 86400000 + 3600000,
                ).toISOString(),
              },
            };
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/events/${event.id}`,
            headers,
            payload: change,
          })
        ).statusCode,
      ).toBe(200);
    }
    await runner.start();
    await waitFor(
      async () =>
        (await jobs().findOne({ name: SEND_JOB }))?.data.outcome === "skipped",
    );
    expect(messages).toHaveLength(0);
  },
);

test("metadata edits use current text without creating another reminder identity", async () => {
  const event = await create(500);
  const runner = await worker();
  await runner.reconcile();
  const response = await app.inject({
    method: "PATCH",
    url: `/events/${event.id}`,
    headers: { authorization: "Bearer alice-dev-token", "if-match": '"1"' },
    payload: { title: "Updated title" },
  });
  expect(response.statusCode).toBe(200);
  await runner.reconcile();
  expect(await jobs().countDocuments({ name: SEND_JOB })).toBe(1);
  await runner.start();
  await waitFor(() => messages.length === 1);
  expect(messages[0]?.text).toContain("Updated title");
});

test("planning retries after scheduling failure and does not acknowledge a concurrent edit", async () => {
  const event = await create(3000);
  const runner = await worker();
  const original = runner.agenda.create.bind(runner.agenda);
  runner.agenda.create = (() => {
    throw new Error("Queue unavailable");
  }) as typeof runner.agenda.create;
  await runner.reconcile();
  let stored = await app.collections.events.findOne({
    _id: new ObjectId(event.id),
  });
  expect(stored?.remindersNextPlanAt).toBeInstanceOf(Date);
  expect(await jobs().countDocuments({ name: SEND_JOB })).toBe(0);
  runner.agenda.create = original;
  await app.collections.events.updateOne(
    { _id: new ObjectId(event.id) },
    { $set: { remindersPending: true } },
  );
  let edited = false;
  runner.agenda.create = ((name: string, data?: unknown) => {
    const job = original(name, data);
    const save = job.save.bind(job);
    job.save = async () => {
      if (!edited) {
        edited = true;
        await app.collections.events.updateOne(
          { _id: new ObjectId(event.id) },
          {
            $set: { remindersPending: true, title: "Concurrent edit" },
            $inc: { revision: 1 },
          },
        );
      }
      return save();
    };
    return job;
  }) as typeof runner.agenda.create;
  await runner.reconcile();
  expect(
    (await app.collections.events.findOne({ _id: new ObjectId(event.id) }))
      ?.remindersPending,
  ).toBe(true);
  runner.agenda.create = original;
  await runner.reconcile();
  stored = await app.collections.events.findOne({
    _id: new ObjectId(event.id),
  });
  expect(stored?.remindersPending).toBe(false);
  expect(await jobs().countDocuments({ name: SEND_JOB })).toBe(1);
});

test("permanent SMTP errors stop retries and transient failures have a finite retry budget", async () => {
  failureCode = 550;
  failures = 100;
  await create();
  const runner = await worker();
  await runner.reconcile();
  await runner.start();
  await waitFor(
    async () => (await jobs().findOne({ name: SEND_JOB }))?.failCount === 1,
  );
  await runner.stop();
  workers = [];
  expect(attempts).toBe(1);
  expect((await jobs().findOne({ name: SEND_JOB }))?.nextRunAt).toBeNull();
  await jobs().deleteMany({});
  await app.collections.events.deleteMany({});
  attempts = 0;
  failureCode = 451;
  await create();
  const retrying = await worker();
  await retrying.reconcile();
  await retrying.start();
  await waitFor(
    async () => (await jobs().findOne({ name: SEND_JOB }))?.failCount === 4,
  );
  await retrying.stop();
  workers = [];
  expect(attempts).toBe(4);
  expect(messages).toHaveLength(0);
  expect((await jobs().findOne({ name: SEND_JOB }))?.failReason).toBe(
    "Temporary SMTP delivery failure.",
  );
});

test("a moved occurrence schedules its new reminder and suppresses the old one", async () => {
  const event = await create(400, { recurrence: { frequency: "daily" } });
  const runner = await worker();
  await runner.reconcile();
  const start = Date.now() + 60800;
  const response = await app.inject({
    method: "PATCH",
    url: `/events/${event.id}/occurrences?originalStart=${encodeURIComponent(event.schedule.startsAt)}`,
    headers: { authorization: "Bearer alice-dev-token", "if-match": '"1"' },
    payload: {
      schedule: {
        kind: "timed",
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 3600000).toISOString(),
      },
    },
  });
  expect(response.statusCode).toBe(200);
  await runner.reconcile();
  await runner.start();
  await waitFor(
    async () =>
      (await jobs().countDocuments({ "data.outcome": "sent" })) === 1 &&
      (await jobs().countDocuments({ "data.outcome": "skipped" })) === 1,
  );
  expect(messages).toHaveLength(1);
});

test("delivery resolves the current private profile without copying it into job data", async () => {
  await create(1000);
  const runner = await worker();
  await runner.reconcile();
  const queued = await jobs().findOne({ name: SEND_JOB });
  const data = JSON.stringify(queued?.data);
  expect(data).not.toContain(users[0]!.email);
  expect(data).not.toContain("alice-dev-token");
  expect(data).not.toContain("Private appointment");
  const profiles = app.mongo.db!.collection<{ _id: string; email: string }>(
    "users",
  );
  try {
    await profiles.updateOne(
      { _id: users[0]!.id },
      { $set: { email: "updated@example.invalid" } },
    );
    await runner.start();
    await waitFor(() => messages.length === 1);
    expect(messages[0]?.to).toBe("updated@example.invalid");
  } finally {
    await profiles.updateOne(
      { _id: users[0]!.id },
      { $set: { email: users[0]!.email } },
    );
  }
});
