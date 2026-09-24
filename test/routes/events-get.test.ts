import { afterAll, beforeAll, beforeEach, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { ObjectId } from "mongodb";
import { Compile } from "typebox/compile";
import App from "../../src/app.js";
import type { EventDocument, StoredSchedule } from "../../src/events/model.js";
import {
  type EventListResponse,
  EventListResponseSchema,
  EventResponseSchema,
  toEventResponse,
} from "../../src/events/response.js";

const app = Fastify({ pluginTimeout: 5 * 60 * 1000 });
const headers = { authorization: "Bearer alice-dev-token" };
const listValidator = Compile(EventListResponseSchema);
const eventValidator = Compile(EventResponseSchema);
let aliceId: string;
let bobId: string;

beforeAll(async () => {
  await app.register(fp(App), {
    mongoUri: undefined,
    mongoTestUri: undefined,
    test: true,
    authSkip: false,
    rateLimitIpMax: 10000,
    rateLimitReadMax: 10000,
    rateLimitWriteMax: 10000,
  });
  await app.ready();
  aliceId = (await app.authenticate("alice-dev-token")).id;
  bobId = (await app.authenticate("bob-dev-token")).id;
});
afterAll(() => app.close());
beforeEach(async () => {
  // A private temporary MongoDB is used for this test app.
  await app.collections.events.deleteMany({});
});

function document(
  ownerId = aliceId,
  schedule: StoredSchedule = {
    kind: "timed",
    startsAt: new Date("2026-10-05T10:00:00+08:00"),
    endsAt: new Date("2026-10-05T11:00:00+08:00"),
  },
): EventDocument {
  const id = new ObjectId();
  return {
    _id: id,
    ownerId,
    uid: id.toHexString(),
    title: "Study",
    eventType: "study",
    allowConflicts: false,
    schedule,
    emailNotifications: { enabled: false },
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function getList(url = "/events"): Promise<EventListResponse> {
  const response = await app.inject({ url, headers });
  assert.equal(response.statusCode, 200, response.payload);
  const body = response.json<EventListResponse>();
  assert.ok(listValidator.Check(body));
  return body;
}

test("GET one event returns its public representation", async () => {
  const event = document();
  await app.collections.events.insertOne(event);
  const response = await app.inject({ url: `/events/${event._id}`, headers });
  assert.equal(response.statusCode, 200, response.payload);
  assert.ok(eventValidator.Check(response.json()));
  assert.deepStrictEqual(response.json(), toEventResponse(event));
});

test("another owner's event is indistinguishable from a missing event", async () => {
  const event = document(bobId);
  await app.collections.events.insertOne(event);
  const foreign = await app.inject({ url: `/events/${event._id}`, headers });
  const missing = await app.inject({
    url: `/events/${new ObjectId()}`,
    headers,
  });
  assert.equal(foreign.statusCode, 404);
  assert.equal(missing.statusCode, 404);
  assert.deepStrictEqual(foreign.json(), missing.json());
});

test.each(["bad-id", "0".repeat(23), "g".repeat(24)])(
  "invalid event ID %s returns 400",
  async (id) => {
    const response = await app.inject({ url: `/events/${id}`, headers });
    assert.equal(response.statusCode, 400);
  },
);

test.each([
  "/events",
  "/events?from=2026-10-05&to=2026-10-12",
  "/events/000000000000000000000001",
])("%s requires authentication", async (url) => {
  const missing = await app.inject({ url });
  const invalid = await app.inject({
    url,
    headers: { authorization: "Bearer unknown" },
  });
  assert.equal(missing.statusCode, 401);
  assert.equal(invalid.statusCode, 401);
});

test("an empty list has no next cursor", async () => {
  assert.deepStrictEqual(await getList(), { items: [], nextCursor: null });
});

test("unfiltered listing includes all dates but only the owner's non-recurring events", async () => {
  const past = document(aliceId, {
    kind: "all-day",
    startsOn: "2020-01-01",
    endsOn: "2020-01-02",
  });
  const future = document(aliceId, {
    kind: "all-day",
    startsOn: "2030-01-01",
    endsOn: "2030-01-02",
  });
  const recurring = document();
  await app.collections.events.insertMany([
    past,
    future,
    recurring,
    document(bobId),
  ]);
  // Seed a future-format series to prove the explicit recurrence exclusion.
  await app.collections.events.updateOne(
    { _id: recurring._id },
    { $set: { recurrence: { frequency: "weekly" } } },
  );
  const body = await getList();
  assert.deepStrictEqual(
    body.items.map((item) => item.id),
    [past, future].map((item) => item._id.toHexString()),
  );
  assert.equal(body.nextCursor, null);
});

test("cursor pages contain every matching event once and preserve owner isolation", async () => {
  const owned = Array.from({ length: 5 }, () => document());
  await app.collections.events.insertMany([...owned, document(bobId)]);
  const first = await getList("/events?limit=2");
  assert.equal(first.items.length, 2);
  assert.equal(first.nextCursor, owned[1]?._id.toHexString());
  const second = await getList(`/events?limit=2&after=${first.nextCursor}`);
  assert.equal(second.items.length, 2);
  const third = await getList(`/events?limit=2&after=${second.nextCursor}`);
  assert.equal(third.items.length, 1);
  assert.equal(third.nextCursor, null);
  assert.deepStrictEqual(
    [...first.items, ...second.items, ...third.items].map((item) => item.id),
    owned.map((item) => item._id.toHexString()),
  );
  const empty = await getList(`/events?after=${owned.at(-1)?._id}`);
  assert.deepStrictEqual(empty, { items: [], nextCursor: null });
});

test("page defaults and maximum limit bound list results", async () => {
  await app.collections.events.insertMany(
    Array.from({ length: 101 }, () => document()),
  );
  const defaultPage = await getList();
  assert.equal(defaultPage.items.length, 50);
  assert.ok(defaultPage.nextCursor);
  const maxPage = await getList("/events?limit=100");
  assert.equal(maxPage.items.length, 100);
  assert.ok(maxPage.nextCursor);
});

test("Hong Kong range filtering includes overlaps and excludes touching boundaries", async () => {
  const timed = (start: string, end: string) =>
    document(aliceId, {
      kind: "timed",
      startsAt: new Date(start),
      endsAt: new Date(end),
    });
  const allDay = (startsOn: string, endsOn: string) =>
    document(aliceId, { kind: "all-day", startsOn, endsOn });
  const included = [
    timed("2026-10-04T16:00:00Z", "2026-10-04T17:00:00Z"), // HK Monday midnight
    timed("2026-10-04T15:00:00Z", "2026-10-04T17:00:00Z"), // crosses start
    timed("2026-10-11T15:00:00Z", "2026-10-11T17:00:00Z"), // crosses end
    timed("2026-10-01T00:00:00Z", "2026-10-20T00:00:00Z"), // spans window
    allDay("2026-10-05", "2026-10-06"),
    allDay("2026-10-04", "2026-10-13"),
  ];
  const excluded = [
    timed("2026-10-04T15:00:00Z", "2026-10-04T16:00:00Z"), // ends at start
    timed("2026-10-11T16:00:00Z", "2026-10-11T17:00:00Z"), // starts at end
    allDay("2026-10-04", "2026-10-05"),
    allDay("2026-10-12", "2026-10-13"),
    document(bobId),
  ];
  await app.collections.events.insertMany([...included, ...excluded]);
  const range = "/events?from=2026-10-05&to=2026-10-12";
  const first = await getList(`${range}&limit=3`);
  assert.ok(first.nextCursor);
  const second = await getList(`${range}&limit=3&after=${first.nextCursor}`);
  assert.equal(second.nextCursor, null);
  assert.deepStrictEqual(
    [...first.items, ...second.items].map((item) => item.id),
    included.map((item) => item._id.toHexString()),
  );
});

test.each([
  "from=2026-10-05",
  "to=2026-10-12",
  "from=2026-10-05&to=2026-10-05",
  "from=2026-10-12&to=2026-10-05",
  "from=2026-01-01&to=2026-04-05", // 94 days
  "from=2026-02-30&to=2026-03-05",
  "from=garbage&to=2026-10-12",
  "from=2026-10-05T00:00:00Z&to=2026-10-12",
  "from=2026-10-05&from=2026-10-06&to=2026-10-12",
  "limit=0",
  "limit=101",
  "limit=-1",
  "limit=1.5",
  "limit=abc",
  "limit=1&limit=2",
  "after=bad-cursor",
  "ownerId=another-user",
  "timeZone=Asia%2FHong_Kong",
])("invalid list query %s returns 400", async (query) => {
  const response = await app.inject({ url: `/events?${query}`, headers });
  assert.equal(response.statusCode, 400, response.payload);
});

test("a 93-day range is allowed", async () => {
  assert.deepStrictEqual(
    await getList("/events?from=2026-01-01&to=2026-04-04"),
    { items: [], nextCursor: null },
  );
});

test("OpenAPI describes both protected GET operations", () => {
  const paths = app.swagger().paths;
  const list = paths?.["/events/"]?.get ?? paths?.["/events"]?.get;
  const single = paths?.["/events/{id}"]?.get;
  assert.ok(list);
  assert.ok(single);
  assert.deepStrictEqual(list.security, [{ Auth: [] }]);
  assert.deepStrictEqual(single.security, [{ Auth: [] }]);
  assert.ok(list.responses?.["200"]);
  assert.ok(single.responses?.["404"]);
});
