import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { Writable } from "node:stream";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { ObjectId } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import App from "../src/app.js";
import { withEventWriteLock } from "../src/events/services/write-lock.js";
import { loadOptions } from "../src/options.js";
import {
  type RateCounter,
  RateLimitMongoStore,
} from "../src/rate-limit-store.js";

const first = Fastify({ pluginTimeout: 300000 });
const second = Fastify({ pluginTimeout: 300000 });
let mongo: MongoMemoryReplSet;
const auth = { authorization: "Bearer alice-dev-token" };
const payload = {
  title: "Shared owner",
  eventType: "study",
  allowConflicts: false,
  schedule: { kind: "all-day", startsOn: "2026-10-05", endsOn: "2026-10-06" },
};
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  for (const app of [first, second]) {
    await app.register(fp(App), {
      test: true,
      authSkip: false,
      mongoUri: undefined,
      mongoTestUri: mongo.getUri("shared"),
      rateLimitIpMax: 10000,
      rateLimitReadMax: 10000,
      rateLimitWriteMax: 4,
    });
    await app.ready();
  }
});
afterAll(async () => {
  await first.close();
  await second.close();
  await mongo.stop();
});
beforeEach(async () => {
  await first.collections.events.deleteMany({});
  await first.mongo.db!.collection("rate_limits").deleteMany({});
});

test("two API instances cannot concurrently create overlapping events", async () => {
  const replies = await Promise.all(
    [first, second].map((app) =>
      app.inject({ method: "POST", url: "/events", headers: auth, payload }),
    ),
  );
  expect(replies.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  expect(await first.collections.events.countDocuments()).toBe(1);
});

test("two API instances cannot move different events into the same interval", async () => {
  const events: { id: string }[] = [];
  for (const day of [7, 9]) {
    const result = await first.inject({
      method: "POST",
      url: "/events",
      headers: auth,
      payload: {
        ...payload,
        schedule: {
          kind: "all-day",
          startsOn: `2026-10-${String(day).padStart(2, "0")}`,
          endsOn: `2026-10-${String(day + 1).padStart(2, "0")}`,
        },
      },
    });
    expect(result.statusCode).toBe(201);
    events.push(result.json());
  }
  const replies = await Promise.all(
    [first, second].map((app, i) =>
      app.inject({
        method: "PATCH",
        url: `/events/${events[i]!.id}`,
        headers: { ...auth, "if-match": '"1"' },
        payload: { schedule: payload.schedule },
      }),
    ),
  );
  expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 409]);
});

test("transaction abort rolls back event writes", async () => {
  const created = await first.inject({
    method: "POST",
    url: "/events",
    headers: auth,
    payload,
  });
  const event = await first.collections.events.findOne({
    _id: new ObjectId(created.json().id),
  });
  expect(event).not.toBeNull();
  await expect(
    withEventWriteLock(
      first.collections.events,
      event!.ownerId,
      async (session) => {
        await first.collections.events.updateOne(
          { _id: event!._id },
          { $set: { title: "Must roll back" } },
          { session },
        );
        throw new Error("Abort deliberately");
      },
    ),
  ).rejects.toThrow("Abort deliberately");
  expect(
    (await first.collections.events.findOne({ _id: event!._id }))?.title,
  ).toBe(payload.title);
});

test("API instances share the authenticated write allowance", async () => {
  for (const app of [first, second, first, second]) {
    const result = await app.inject({
      method: "POST",
      url: "/events",
      headers: auth,
      payload: {},
    });
    expect(result.statusCode).toBe(400);
  }
  const blocked = await first.inject({
    method: "POST",
    url: "/events",
    headers: auth,
    payload,
  });
  expect(blocked.statusCode).toBe(429);
  expect(blocked.headers["x-ratelimit-scope"]).toBe("user-write");
  expect(
    (
      await second.inject({
        method: "POST",
        url: "/events",
        headers: { authorization: "Bearer bob-dev-token" },
        payload,
      })
    ).statusCode,
  ).toBe(201);
});

test("more than 5000 active counters do not erase a live budget; expiry resets atomically", async () => {
  const collection = first.mongo.db!.collection<RateCounter>("rate_limits");
  const store = new RateLimitMongoStore(collection);
  const other = new RateLimitMongoStore(
    second.mongo.db!.collection<RateCounter>("rate_limits"),
  );
  expect((await store.consume("ip", "victim", 60000, 1)).allowed).toBe(true);
  // Exercise the store itself, in bounded batches, beyond the former eviction threshold.
  for (let offset = 0; offset < 5100; offset += 100) {
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        store.consume("ip", `key-${offset + i}`, 60000, 1),
      ),
    );
  }
  expect((await other.consume("ip", "victim", 60000, 1)).allowed).toBe(false);
  await collection.updateMany({}, { $set: { expiresAt: new Date(0) } });
  const results = await Promise.all(
    [store, other].map((s) => s.consume("ip", "victim", 60000, 1)),
  );
  expect(results.filter((r) => r.allowed)).toHaveLength(1);
});

test("counter failure returns 503 without writing an event", async () => {
  const consume = spyOn(
    RateLimitMongoStore.prototype,
    "consume",
  ).mockRejectedValueOnce(new Error("Database unavailable"));
  try {
    const response = await first.inject({
      method: "POST",
      url: "/events",
      headers: auth,
      payload,
    });
    expect(response.statusCode).toBe(503);
    expect(await first.collections.events.countDocuments()).toBe(0);
    expect(response.payload).not.toContain("Database unavailable");
  } finally {
    consume.mockRestore();
  }
});

test("display-only edits preserve planning state; schedule edits mark it pending", async () => {
  const created = await first.inject({
    method: "POST",
    url: "/events",
    headers: auth,
    payload,
  });
  const id = created.json().id;
  await first.collections.events.updateOne(
    { _id: new ObjectId(id) },
    { $set: { remindersPending: false } },
  );
  const changed = await second.inject({
    method: "PATCH",
    url: `/events/${id}`,
    headers: { ...auth, "if-match": '"1"' },
    payload: { title: "New text", color: "#000000" },
  });
  expect(changed.statusCode).toBe(200);
  expect(
    (await first.collections.events.findOne({ _id: new ObjectId(id) }))
      ?.remindersPending,
  ).toBe(false);
  const scheduled = await first.inject({
    method: "PATCH",
    url: `/events/${id}`,
    headers: { ...auth, "if-match": '"2"' },
    payload: { emailNotifications: { enabled: true } },
  });
  expect(scheduled.statusCode).toBe(200);
  expect(
    (await first.collections.events.findOne({ _id: new ObjectId(id) }))
      ?.remindersPending,
  ).toBe(true);
});

test("malformed auth configuration fails closed at startup", () => {
  for (const value of ["ture", "flase", "", " ", "2"])
    expect(() => loadOptions({ AUTH_SKIP: value })).toThrow("AUTH_SKIP");
  expect(() => loadOptions({ AUTH: "ture" })).toThrow("AUTH_SKIP");
});

test("debug logging redacts authorization even when request headers are explicitly logged", async () => {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const config = loadOptions({}).logger;
  if (!config || typeof config !== "object")
    throw new Error("Missing logger configuration");
  const app = Fastify({ logger: { ...config, level: "debug", stream } });
  app.get("/", async (request) => {
    request.log.debug({ headers: request.headers }, "request headers");
    return { ok: true };
  });
  await app.inject({
    url: "/",
    headers: {
      authorization: "Bearer secret-test-token",
      cookie: "session=secret-cookie",
    },
  });
  await app.close();
  expect(output).toContain("request headers");
  expect(output).toContain("[Redacted]");
  expect(output).not.toContain("secret-test-token");
  expect(output).not.toContain("secret-cookie");
});

test("occurrence text edits do not replan; cancellation does", async () => {
  const result = await first.inject({
    method: "POST",
    url: "/events",
    headers: auth,
    payload: {
      ...payload,
      recurrence: { frequency: "daily", endsOn: "2026-10-07" },
    },
  });
  expect(result.statusCode).toBe(201);
  const id = result.json().id;
  await first.collections.events.updateOne(
    { _id: new ObjectId(id) },
    { $set: { remindersPending: false } },
  );
  const edited = await second.inject({
    method: "PATCH",
    url: `/events/${id}/occurrences?originalStart=2026-10-05`,
    headers: { ...auth, "if-match": '"1"' },
    payload: { title: "Occurrence text" },
  });
  expect(edited.statusCode).toBe(200);
  expect(
    (await first.collections.events.findOne({ _id: new ObjectId(id) }))
      ?.remindersPending,
  ).toBe(false);
  const cancelled = await first.inject({
    method: "DELETE",
    url: `/events/${id}/occurrences?originalStart=2026-10-05`,
    headers: { ...auth, "if-match": '"2"' },
  });
  expect(cancelled.statusCode).toBe(200);
  expect(
    (await first.collections.events.findOne({ _id: new ObjectId(id) }))
      ?.remindersPending,
  ).toBe(true);
});
