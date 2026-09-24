import { afterAll, beforeAll, beforeEach, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { ObjectId } from "mongodb";
import { Compile } from "typebox/compile";
import App from "../../../src/app.js";
import {
  type EventResponse,
  EventResponseSchema,
} from "../../../src/events/http/response.js";
import type { CreateEventInput } from "../../../src/events/schemas/event.js";

const app = Fastify({ pluginTimeout: 5 * 60 * 1000 });
const responseValidator = Compile(EventResponseSchema);
const headers = { authorization: "Bearer alice-dev-token" };
const validEvent: CreateEventInput = {
  title: "Doctor appointment",
  description: "Bring confirmation",
  location: "Campus clinic",
  eventType: "appointment",
  allowConflicts: false,
  schedule: {
    kind: "timed",
    startsAt: "2026-10-05T10:00:00+08:00",
    endsAt: "2026-10-05T11:00:00+08:00",
  },
};

beforeAll(async () => {
  await app.register(fp(App), {
    mongoUri: undefined,
    mongoTestUri: undefined,
    test: true,
    authSkip: false,
    // CRUD tests exercise validation independently of traffic limits.
    rateLimitIpMax: 10000,
    rateLimitReadMax: 10000,
    rateLimitWriteMax: 10000,
  });
  await app.ready();
});

afterAll(() => app.close());
beforeEach(async () => {
  // This app always uses its own temporary MongoDB, never a configured database.
  await app.collections.events.deleteMany({});
});

test("POST /events stores an owned event and returns a public 201 response", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/events",
    headers,
    payload: validEvent,
  });
  assert.equal(response.statusCode, 201, response.payload);
  const body = response.json<EventResponse>();
  assert.ok(responseValidator.Check(body));
  assert.equal(body.title, validEvent.title);
  assert.equal(body.description, validEvent.description);
  assert.equal(body.location, validEvent.location);
  assert.equal(body.revision, 1);
  assert.equal(body.createdAt, body.updatedAt);
  assert.deepStrictEqual(body.schedule, {
    kind: "timed",
    startsAt: "2026-10-05T02:00:00.000Z",
    endsAt: "2026-10-05T03:00:00.000Z",
  });
  assert.deepStrictEqual(body.emailNotifications, {
    enabled: false,
  });
  const alice = await app.authenticate("alice-dev-token");
  const stored = await app.collections.events.findOne({
    _id: new ObjectId(body.id),
    ownerId: alice.id,
  });
  assert.ok(stored);
  assert.equal(stored.uid, body.uid);
  assert.equal(stored.schedule.kind, "timed");
  if (stored.schedule.kind === "timed") {
    assert.ok(stored.schedule.startsAt instanceof Date);
    assert.equal(
      stored.schedule.startsAt.toISOString(),
      "2026-10-05T02:00:00.000Z",
    );
  }
  assert.ok(stored.createdAt instanceof Date);
  assert.deepStrictEqual(stored.emailNotifications, body.emailNotifications);
  assert.equal(await app.collections.events.countDocuments(), 1);
});

test("all-day creation preserves Hong Kong dates and defaults other types to email off", async () => {
  const schedule = {
    kind: "all-day",
    startsOn: "2026-10-05",
    endsOn: "2026-10-06",
  };
  const response = await app.inject({
    method: "POST",
    url: "/events",
    headers,
    payload: { ...validEvent, eventType: "personal", schedule },
  });
  assert.equal(response.statusCode, 201, response.payload);
  const body = response.json<EventResponse>();
  assert.ok(responseValidator.Check(body));
  assert.deepStrictEqual(body.schedule, schedule);
  assert.deepStrictEqual(body.emailNotifications, { enabled: false });
  const stored = await app.collections.events.findOne({
    _id: new ObjectId(body.id),
  });
  assert.deepStrictEqual(stored?.schedule, schedule);
});

test.each([{ enabled: false }])(
  "creation preserves explicit notification settings %#",
  async (emailNotifications) => {
    const response = await app.inject({
      method: "POST",
      url: "/events",
      headers,
      payload: { ...validEvent, emailNotifications },
    });
    assert.equal(response.statusCode, 201, response.payload);
    assert.deepStrictEqual(
      response.json().emailNotifications,
      emailNotifications,
    );
  },
);

test("Alice and Bob create events with separate server-derived ownership and identities", async () => {
  const responses = await Promise.all(
    ["alice-dev-token", "bob-dev-token"].map(async (token) => {
      const user = await app.authenticate(token);
      const response = await app.inject({
        method: "POST",
        url: "/events",
        headers: { authorization: `Bearer ${token}` },
        payload: validEvent,
      });
      assert.equal(response.statusCode, 201, response.payload);
      const body = response.json<EventResponse>();
      assert.ok(
        await app.collections.events.findOne({
          _id: new ObjectId(body.id),
          ownerId: user.id,
        }),
      );
      return body;
    }),
  );
  assert.equal(new Set(responses.map((body) => body.id)).size, 2);
  assert.equal(new Set(responses.map((body) => body.uid)).size, 2);
});

test.each([undefined, "Bearer unknown-token"])(
  "unauthenticated creation %# cannot write",
  async (authorization) => {
    const response = await app.inject({
      method: "POST",
      url: "/events",
      headers: authorization ? { authorization } : {},
      payload: validEvent,
    });
    assert.equal(response.statusCode, 401, response.payload);
    assert.equal(await app.collections.events.countDocuments(), 0);
  },
);

test.each([
  "ownerId",
  "_id",
  "id",
  "uid",
  "revision",
  "createdAt",
  "updatedAt",
  "exceptions",
  "timeZone",
  "isOptional",
])(
  "rejects client-supplied %s instead of silently stripping it",
  async (field) => {
    const response = await app.inject({
      method: "POST",
      url: "/events",
      headers,
      payload: { ...validEvent, [field]: "untrusted" },
    });
    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(await app.collections.events.countDocuments(), 0);
  },
);

const invalidChanges = [
  { schedule: { ...validEvent.schedule, timeZone: "Asia/Hong_Kong" } },
  {
    schedule: {
      kind: "all-day",
      startsOn: "2026-10-05",
      endsOn: "2026-10-06",
      timeZone: "Asia/Hong_Kong",
    },
  },
  { schedule: { ...validEvent.schedule, startsAt: "2026-10-05T10:00:00" } },
  {
    schedule: { ...validEvent.schedule, startsAt: "2026-02-30T10:00:00+08:00" },
  },
  { allowConflicts: "false" },
  { title: "  " },
  { emailNotifications: { enabled: true, minutesBefore: [120, 120] } },
  { emailNotifications: { enabled: true, minutesBefore: ["120"] } },
  { emailNotifications: { enabled: false, minutesBefore: [120] } },
];

test.each(invalidChanges)(
  "invalid request %# is rejected before insertion",
  async (changes) => {
    const response = await app.inject({
      method: "POST",
      url: "/events",
      headers,
      payload: { ...validEvent, ...changes },
    });
    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(response.json().error, "Bad Request");
    assert.equal(await app.collections.events.countDocuments(), 0);
  },
);

test.each([
  {
    kind: "timed",
    startsAt: "2026-10-05T10:00:00+08:00",
    endsAt: "2026-10-05T02:00:00Z",
  },
  { kind: "all-day", startsOn: "2026-10-06", endsOn: "2026-10-05" },
])("business-rule failure %# returns 400 without saving", async (schedule) => {
  const response = await app.inject({
    method: "POST",
    url: "/events",
    headers,
    payload: { ...validEvent, schedule },
  });
  assert.equal(response.statusCode, 400, response.payload);
  assert.match(response.json().message, /must be after/);
  assert.equal(await app.collections.events.countDocuments(), 0);
});

test("OpenAPI documents the protected create endpoint", () => {
  const operation =
    app.swagger().paths?.["/events/"]?.post ??
    app.swagger().paths?.["/events"]?.post;
  assert.ok(operation);
  assert.deepStrictEqual(operation.security, [{ Auth: [] }]);
  assert.ok("requestBody" in operation && operation.requestBody);
  assert.ok(operation.responses?.["201"]);
  assert.ok(operation.responses?.["400"]);
  assert.ok(operation.responses?.["401"]);
});

test.each([{ enabled: true }, { enabled: true, minutesBefore: [1440, 120] }])(
  "POST rejects enabling email without writing %#",
  async (emailNotifications) => {
    const response = await app.inject({
      method: "POST",
      url: "/events",
      headers,
      payload: { ...validEvent, emailNotifications },
    });
    assert.equal(response.statusCode, 400, response.payload);
    assert.match(response.json().message, /not available yet/);
    assert.equal(await app.collections.events.countDocuments(), 0);
  },
);
