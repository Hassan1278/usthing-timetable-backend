import { MongoBackend } from "@agendajs/mongo-backend";
import { Agenda, type Job } from "agenda";
import { type Db, ObjectId } from "mongodb";
import type { UserDocument } from "../auth/user-store.js";
import type { EventDocument } from "../events/domain/model.js";
import { expandEvent, interval } from "../events/recurrence/series.js";
import { DeliveryError, type SendReminder, validEmail } from "./mail.js";
import {
  LATE_GRACE_MS,
  PLAN_JOB,
  planReminders,
  type Reminder,
  reminderFor,
  SEND_JOB,
} from "./planning.js";

export const JOB_COLLECTION = "reminder_jobs";
type Log = (message: string, jobId?: string) => void;

export async function createReminderScheduler(
  db: Db,
  send: SendReminder,
  options: {
    processEveryMs?: number;
    retryDelayMs?: number;
    now?: () => number;
    log?: Log;
  } = {},
) {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const events = db.collection<EventDocument>("events");
  const users = db.collection<UserDocument>("users");
  const jobs = db.collection(JOB_COLLECTION);
  await jobs.createIndex(
    { name: 1, "data.key": 1 },
    {
      unique: true,
      partialFilterExpression: { name: SEND_JOB },
      name: "unique_reminder",
    },
  );
  await jobs.createIndex({ "data.expiresAt": 1 }, { expireAfterSeconds: 0 });
  await jobs.createIndex(
    { name: 1 },
    {
      unique: true,
      partialFilterExpression: { name: PLAN_JOB },
      name: "single_reminder_planner",
    },
  );
  await events.createIndex({ remindersPending: 1, remindersNextPlanAt: 1 });
  const agenda = new Agenda({
    backend: new MongoBackend({ mongo: db, collection: JOB_COLLECTION }),
    processEvery: options.processEveryMs ?? 1000,
    maxConcurrency: 3,
    defaultLockLifetime: 120_000,
    defaultLockLimit: 3,
  });
  agenda.on("error", () => log("Reminder scheduler database error."));
  agenda.on("fail", (_error, job) =>
    log("Reminder job failed.", String(job.attrs._id)),
  );
  agenda.on("retry exhausted", (_error, job) =>
    log("Reminder retries exhausted.", String(job.attrs._id)),
  );

  async function scheduleEvent(event: EventDocument, timestamp: number) {
    for (const reminder of planReminders(event, timestamp)) {
      await agenda
        .create(SEND_JOB, reminder)
        .unique({ "data.key": reminder.key }, { insertOnly: true })
        .schedule(new Date(reminder.dueAt))
        .save();
    }
  }

  async function reconcile(heartbeat?: () => Promise<unknown>) {
    const timestamp = now();
    const cursor = events
      .find({
        $or: [
          { remindersPending: true },
          { remindersNextPlanAt: { $lte: new Date(timestamp) } },
          { remindersNextPlanAt: { $exists: false } },
        ],
      })
      .sort({ remindersNextPlanAt: 1, _id: 1 })
      .limit(50)
      .maxTimeMS(5000);
    try {
      for await (const event of cursor) {
        let nextPlan = timestamp + 60 * 60 * 1000;
        try {
          await scheduleEvent(event, timestamp);
        } catch {
          // Keep a durable retry timestamp even after partially scheduling jobs.
          nextPlan = timestamp + 60_000;
          log("Reminder planning failed; will retry.", event._id.toHexString());
        }
        // An edit during planning must retain its pending marker.
        await events.updateOne(
          { _id: event._id, revision: event.revision },
          {
            $set: {
              remindersPending: false,
              remindersNextPlanAt: new Date(nextPlan),
            },
          },
        );
        await heartbeat?.();
      }
    } finally {
      await cursor.close();
    }
  }

  async function deliver(job: Job<Reminder>) {
    const reminder = job.attrs.data;
    if (reminder.outcome === "sent") return;
    const skip = async () => {
      job.attrs.data.outcome = "skipped";
      await job.save();
    };
    const event = await events.findOne({
      _id: new ObjectId(reminder.eventId),
      ownerId: reminder.ownerId,
    });
    const timestamp = now();
    if (
      !event ||
      timestamp < reminder.dueAt ||
      timestamp > reminder.dueAt + LATE_GRACE_MS ||
      (reminder.minutesBefore !== 0 && timestamp >= reminder.startsAt)
    )
      return skip();
    const occurrence = expandEvent(event).find((item) => {
      const originalStart =
        item.originalStart ??
        (item.schedule.kind === "timed"
          ? item.schedule.startsAt.toISOString()
          : item.schedule.startsOn);
      return originalStart === reminder.originalStart;
    });
    if (
      !occurrence?.emailNotifications.enabled ||
      !occurrence.emailNotifications.minutesBefore.includes(
        reminder.minutesBefore,
      ) ||
      reminderFor(
        event,
        reminder.originalStart,
        interval(occurrence.schedule).start,
        reminder.minutesBefore,
      ).key !== reminder.key
    )
      return skip();
    const user = await users.findOne({ _id: event.ownerId });
    if (!user || !validEmail(user.email)) throw new DeliveryError(false);
    await send(user.email, occurrence, reminder);
    job.attrs.data.outcome = "sent";
    await job.save();
  }

  agenda.define<Reminder>(SEND_JOB, deliver, {
    concurrency: 2,
    lockLimit: 2,
    lockLifetime: 120_000,
    backoff: ({ attempt, error }) =>
      error instanceof DeliveryError && !error.retryable
        ? null
        : attempt <= 3
          ? (options.retryDelayMs ?? 5000) * 2 ** (attempt - 1)
          : null,
  });
  agenda.define(PLAN_JOB, async (job) => reconcile(() => job.touch()), {
    concurrency: 1,
    lockLimit: 1,
    lockLifetime: 120_000,
  });
  await agenda.ready;
  return {
    agenda,
    reconcile,
    // Read shared progress: another worker may have acquired the planner job.
    async isReady() {
      return Boolean(
        await jobs.findOne(
          {
            name: PLAN_JOB,
            lastFinishedAt: { $gt: new Date(now() - 120_000) },
          },
          { projection: { _id: 1 }, timeoutMS: 2000 },
        ),
      );
    },
    async start() {
      await agenda.start();
      await agenda.every("5 seconds", PLAN_JOB);
    },
    async stop() {
      await agenda.drain(30_000);
      await agenda.stop();
    },
  };
}
