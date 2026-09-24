import { afterAll, beforeAll, beforeEach, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { ObjectId } from "mongodb";
import App from "../../src/app.js";
import type { CreateEventInput } from "../../src/events/schemas.js";

const app = Fastify({ pluginTimeout: 300000 });
const headers = { authorization: "Bearer alice-dev-token" };
type Schedule = CreateEventInput["schedule"];
const timed = (startsAt: string, endsAt: string): Schedule => ({
  kind: "timed",
  startsAt,
  endsAt,
});
const allDay = (startsOn: string, endsOn: string): Schedule => ({
  kind: "all-day",
  startsOn,
  endsOn,
});
const original = timed(
  "2026-10-05T10:00:00+08:00",
  "2026-10-05T11:00:00+08:00",
);

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
});
afterAll(() => app.close());
beforeEach(async () => {
  await app.collections.events.deleteMany({});
});

function create(
  schedule = original,
  allowConflicts = false,
  token = "alice-dev-token",
) {
  return app.inject({
    method: "POST",
    url: "/events",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      title: "Event",
      eventType: "personal",
      allowConflicts,
      schedule,
    },
  });
}

const cases: {
  name: string;
  existing: Schedule;
  incoming: Schedule;
  status: number;
}[] = [
  {
    name: "equal timed intervals",
    existing: original,
    incoming: original,
    status: 409,
  },
  {
    name: "partial timed overlap",
    existing: original,
    incoming: timed("2026-10-05T10:30:00+08:00", "2026-10-05T11:30:00+08:00"),
    status: 409,
  },
  {
    name: "enclosing interval",
    existing: original,
    incoming: timed("2026-10-05T09:00:00+08:00", "2026-10-05T12:00:00+08:00"),
    status: 409,
  },
  {
    name: "touching timed end",
    existing: original,
    incoming: timed("2026-10-05T11:00:00+08:00", "2026-10-05T12:00:00+08:00"),
    status: 201,
  },
  {
    name: "touching timed start",
    existing: original,
    incoming: timed("2026-10-05T09:00:00+08:00", "2026-10-05T10:00:00+08:00"),
    status: 201,
  },
  {
    name: "overlapping all-day intervals",
    existing: allDay("2026-10-05", "2026-10-07"),
    incoming: allDay("2026-10-06", "2026-10-08"),
    status: 409,
  },
  {
    name: "touching all-day intervals",
    existing: allDay("2026-10-05", "2026-10-06"),
    incoming: allDay("2026-10-06", "2026-10-07"),
    status: 201,
  },
  {
    name: "timed event during all-day",
    existing: allDay("2026-10-05", "2026-10-06"),
    incoming: original,
    status: 409,
  },
  {
    name: "all-day event covering timed",
    existing: original,
    incoming: allDay("2026-10-05", "2026-10-06"),
    status: 409,
  },
  {
    name: "UTC instant on HK next day",
    existing: allDay("2026-10-05", "2026-10-06"),
    incoming: timed("2026-10-04T16:00:00Z", "2026-10-04T17:00:00Z"),
    status: 409,
  },
  {
    name: "timed end at all-day start",
    existing: allDay("2026-10-05", "2026-10-06"),
    incoming: timed("2026-10-04T15:00:00Z", "2026-10-04T16:00:00Z"),
    status: 201,
  },
  {
    name: "timed start at all-day end",
    existing: allDay("2026-10-05", "2026-10-06"),
    incoming: timed("2026-10-05T16:00:00Z", "2026-10-05T17:00:00Z"),
    status: 201,
  },
  {
    name: "all-day starts at timed end",
    existing: timed("2026-10-04T15:00:00Z", "2026-10-04T16:00:00Z"),
    incoming: allDay("2026-10-05", "2026-10-06"),
    status: 201,
  },
];

test.each(cases)(
  "backend overlap rule: $name",
  async ({ existing, incoming, status }) => {
    assert.equal((await create(existing, true)).statusCode, 201);
    const result = await create(incoming);
    assert.equal(result.statusCode, status, result.payload);
    assert.equal(
      await app.collections.events.countDocuments(),
      status === 409 ? 1 : 2,
    );
  },
);

test("explicit allowConflicts permits an overlap; other users do not conflict", async () => {
  assert.equal((await create()).statusCode, 201);
  assert.equal((await create(original, true)).statusCode, 201);
  assert.equal(
    (await create(original, false, "bob-dev-token")).statusCode,
    201,
  );
});

test("PATCH checks conflicts excluding itself and preserves failed revisions", async () => {
  const first = await create();
  const later = timed("2026-10-05T12:00:00+08:00", "2026-10-05T13:00:00+08:00");
  const second = await create(later);
  assert.equal(second.statusCode, 201);
  const url = `/events/${second.json().id}`;
  const before = await app.collections.events.findOne({
    _id: new ObjectId(second.json().id),
  });
  const rejected = await app.inject({
    method: "PATCH",
    url,
    headers: { ...headers, "if-match": '"1"' },
    payload: { schedule: original },
  });
  assert.equal(rejected.statusCode, 409, rejected.payload);
  assert.deepStrictEqual(
    await app.collections.events.findOne({
      _id: new ObjectId(second.json().id),
    }),
    before,
  );
  const accepted = await app.inject({
    method: "PATCH",
    url,
    headers: { ...headers, "if-match": '"1"' },
    payload: { title: "Changed" },
  });
  assert.equal(accepted.statusCode, 200, accepted.payload);
  const override = await app.inject({
    method: "PATCH",
    url,
    headers: { ...headers, "if-match": '"2"' },
    payload: { schedule: original, allowConflicts: true },
  });
  assert.equal(override.statusCode, 200);
  const disable = await app.inject({
    method: "PATCH",
    url,
    headers: { ...headers, "if-match": '"3"' },
    payload: { allowConflicts: false },
  });
  assert.equal(disable.statusCode, 409);
  const remove = await app.inject({
    method: "DELETE",
    url: `/events/${first.json().id}`,
    headers: { ...headers, "if-match": '"1"' },
  });
  assert.equal(remove.statusCode, 204);
  const retry = await app.inject({
    method: "PATCH",
    url,
    headers: { ...headers, "if-match": '"3"' },
    payload: { allowConflicts: false },
  });
  assert.equal(retry.statusCode, 200);
});

test("concurrent overlapping creates have one winner", async () => {
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => create()),
  );
  assert.equal(
    responses.filter((response) => response.statusCode === 201).length,
    1,
  );
  assert.equal(
    responses.filter((response) => response.statusCode === 409).length,
    3,
  );
  assert.equal(await app.collections.events.countDocuments(), 1);
});

test("concurrent edits to different events cannot both occupy the same interval", async () => {
  const first = await create();
  const second = await create(
    timed("2026-10-05T12:00:00+08:00", "2026-10-05T13:00:00+08:00"),
  );
  const schedule = timed(
    "2026-10-05T14:00:00+08:00",
    "2026-10-05T15:00:00+08:00",
  );
  const responses = await Promise.all(
    [first, second].map((event) =>
      app.inject({
        method: "PATCH",
        url: `/events/${event.json().id}`,
        headers: { ...headers, "if-match": '"1"' },
        payload: { schedule },
      }),
    ),
  );
  assert.deepStrictEqual(
    responses.map((response) => response.statusCode).sort(),
    [200, 409],
  );
});

test("create and update share conflict protection", async () => {
  const event = await create();
  const schedule = timed(
    "2026-10-05T14:00:00+08:00",
    "2026-10-05T15:00:00+08:00",
  );
  const responses = await Promise.all([
    create(schedule),
    app.inject({
      method: "PATCH",
      url: `/events/${event.json().id}`,
      headers: { ...headers, "if-match": '"1"' },
      payload: { schedule },
    }),
  ]);
  assert.equal(
    responses.filter((response) => [200, 201].includes(response.statusCode))
      .length,
    1,
  );
  assert.equal(
    responses.filter((response) => response.statusCode === 409).length,
    1,
  );
});
