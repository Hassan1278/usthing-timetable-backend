import {
  afterAll,
  beforeAll,
  beforeEach,
  onTestFinished,
  test,
} from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import fp from "fastify-plugin";
import ICAL from "ical.js";
import { ObjectId } from "mongodb";
import App from "../../../src/app.js";
import { ICS_EXPORT_LIMIT } from "../../../src/events/http/ics.js";
import type { CreateEventInput } from "../../../src/events/schemas/event.js";
import { createEvent } from "../../../src/events/services/events.js";

const app = Fastify({ pluginTimeout: 300000 });
const headers = { authorization: "Bearer alice-dev-token" };
const input: CreateEventInput = {
  title: "Study",
  eventType: "study",
  allowConflicts: true,
  schedule: {
    kind: "timed",
    startsAt: "2026-10-05T10:00:00+08:00",
    endsAt: "2026-10-05T11:00:00+08:00",
  },
};
let alice: string;
let bob: string;
beforeAll(async () => {
  await app.register(fp(App), {
    test: true,
    authSkip: false,
    mongoUri: undefined,
    mongoTestUri: undefined,
    rateLimitIpMax: 10000,
    rateLimitReadMax: 10000,
    rateLimitWriteMax: 10000,
  });
  await app.ready();
  alice = (await app.authenticate("alice-dev-token")).id;
  bob = (await app.authenticate("bob-dev-token")).id;
});
afterAll(() => app.close());
beforeEach(() => app.collections.events.deleteMany({}));
const entries = (source: string) =>
  new ICAL.Component(ICAL.parse(source)).getAllSubcomponents("vevent");

test.each([undefined, "Bearer invalid"])(
  "export requires authentication %#",
  async (authorization) => {
    const response = await app.inject({
      url: "/events/export.ics",
      headers: authorization ? { authorization } : {},
    });
    assert.equal(response.statusCode, 401);
  },
);

test("empty calendar is a downloadable ICS file, not a JSON string", async () => {
  const response = await app.inject({ url: "/events/export.ics", headers });
  assert.equal(response.statusCode, 200, response.payload);
  assert.equal(
    response.headers["content-type"],
    "text/calendar; charset=utf-8",
  );
  assert.equal(
    response.headers["content-disposition"],
    'attachment; filename="usthing-events.ics"',
  );
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.match(
    String(response.headers["access-control-expose-headers"]),
    /Content-Disposition/i,
  );
  assert.ok(response.payload.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(response.payload.endsWith("END:VCALENDAR\r\n"));
  assert.equal(entries(response.payload).length, 0);
});

test("export preserves UIDs, UTC instants and exclusive all-day dates, without private metadata", async () => {
  const timed = await createEvent(app.collections.events, input, alice);
  await createEvent(
    app.collections.events,
    { ...input, title: "Private Bob event" },
    bob,
  );
  const allDay = await createEvent(
    app.collections.events,
    {
      ...input,
      title: "Holiday",
      schedule: {
        kind: "all-day",
        startsOn: "2026-10-06",
        endsOn: "2026-10-08",
      },
    },
    alice,
  );
  const response = await app.inject({ url: "/events/export.ics", headers });
  assert.equal(response.statusCode, 200, response.payload);
  const data = entries(response.payload);
  assert.equal(data.length, 2);
  const first = data.find(
    (event) => event.getFirstPropertyValue("uid") === timed.uid,
  );
  const second = data.find(
    (event) => event.getFirstPropertyValue("uid") === allDay.uid,
  );
  assert.ok(first && second);
  assert.equal(
    first.getFirstPropertyValue("dtstart")?.toString(),
    "2026-10-05T02:00:00Z",
  );
  assert.equal(
    first.getFirstPropertyValue("dtend")?.toString(),
    "2026-10-05T03:00:00Z",
  );
  assert.equal(second.getFirstProperty("dtstart")?.type, "date");
  assert.equal(second.getFirstPropertyValue("dtend")?.toString(), "2026-10-08");
  assert.equal(first.getFirstPropertyValue("sequence"), 0);
  assert.ok(first.hasProperty("dtstamp"));
  for (const secret of [
    alice,
    bob,
    timed._id.toHexString(),
    "alice-dev-token",
    "Private Bob event",
    "VALARM",
    "emailNotifications",
    "allowConflicts",
  ])
    assert.ok(!response.payload.includes(secret), secret);
  assert.equal(
    (await app.inject({ url: "/events/export.ics", headers })).payload,
    response.payload,
  );
});

test("text escaping prevents ICS property injection and preserves Unicode across folded lines", async () => {
  const description =
    "Bring notes, pen; and \\ supplies\nBEGIN:VEVENT\nSUMMARY:Injected\nEND:VEVENT\n" +
    "香港📅".repeat(80);
  const event = await createEvent(
    app.collections.events,
    {
      ...input,
      title: "香港 study; planning, notes",
      description,
      location: "Room A, floor 2; East",
    },
    alice,
  );
  const response = await app.inject({ url: "/events/export.ics", headers });
  assert.equal(response.statusCode, 200, response.payload);
  const data = entries(response.payload);
  assert.equal(data.length, 1);
  assert.equal(data[0]?.getFirstPropertyValue("description"), description);
  assert.equal(data[0]?.getFirstPropertyValue("summary"), event.title);
  assert.equal(data[0]?.getFirstPropertyValue("location"), event.location);
  assert.ok(response.payload.includes("\r\n "));
  assert.ok(!response.payload.includes("�"));
});

test("export normalizes CRLF and bare CR before escaping and removes invalid controls", async () => {
  await createEvent(
    app.collections.events,
    { ...input, description: "Line one\r\nLine two\rSUMMARY:Injected\u0000" },
    alice,
  );
  const response = await app.inject({ url: "/events/export.ics", headers });
  const data = entries(response.payload);
  assert.equal(data.length, 1);
  assert.equal(data[0]?.getFirstPropertyValue("summary"), "Study");
  assert.equal(
    data[0]?.getFirstPropertyValue("description"),
    "Line one\nLine two\nSUMMARY:Injected",
  );
  assert.ok(!response.payload.replaceAll("\r\n", "").includes("\r"));
});

test("date-range exports use HK midnight and exclude touching boundaries", async () => {
  for (const [title, startsAt, endsAt] of [
    ["Before", "2026-10-04T23:00:00+08:00", "2026-10-05T00:00:00+08:00"],
    ["Inside", "2026-10-04T16:00:00Z", "2026-10-04T17:00:00Z"],
    ["After", "2026-10-06T00:00:00+08:00", "2026-10-06T01:00:00+08:00"],
  ] as const)
    await createEvent(
      app.collections.events,
      { ...input, title, schedule: { kind: "timed", startsAt, endsAt } },
      alice,
    );
  await createEvent(
    app.collections.events,
    {
      ...input,
      title: "All day",
      schedule: {
        kind: "all-day",
        startsOn: "2026-10-05",
        endsOn: "2026-10-06",
      },
    },
    alice,
  );
  const response = await app.inject({
    url: "/events/export.ics?from=2026-10-05&to=2026-10-06",
    headers,
  });
  assert.equal(response.statusCode, 200, response.payload);
  assert.deepStrictEqual(
    entries(response.payload)
      .map((event) => event.getFirstPropertyValue("summary"))
      .sort(),
    ["All day", "Inside"],
  );
});

test.each([
  "from=2026-10-05",
  "from=2026-10-06&to=2026-10-05",
  "from=2026-02-30&to=2026-03-02",
  "from=2026-01-01&to=2026-12-31",
  "ownerId=bob",
  "timeZone=UTC",
  "limit=10",
  "after=012345678901234567890123",
])("export rejects invalid query %s", async (query) => {
  assert.equal(
    (await app.inject({ url: `/events/export.ics?${query}`, headers }))
      .statusCode,
    400,
  );
});

test("export handles more than one JSON page and refuses oversized selections without truncation", async () => {
  const seed = await createEvent(app.collections.events, input, alice);
  await app.collections.events.insertMany(
    Array.from({ length: ICS_EXPORT_LIMIT - 1 }, (_, i) => ({
      ...seed,
      _id: new ObjectId(),
      uid: `export-${i}`,
    })),
  );
  const response = await app.inject({ url: "/events/export.ics", headers });
  assert.equal(response.statusCode, 200, response.payload);
  assert.equal(entries(response.payload).length, ICS_EXPORT_LIMIT);
  await app.collections.events.insertOne({
    ...seed,
    _id: new ObjectId(),
    uid: "one-too-many",
  });
  const denied = await app.inject({ url: "/events/export.ics", headers });
  assert.equal(denied.statusCode, 413, denied.payload);
  assert.match(denied.json().message, /1000/);
  assert.equal(
    (
      await app.inject({
        url: "/events/export.ics?from=2026-11-01&to=2026-11-02",
        headers,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    await app.collections.events.countDocuments(),
    ICS_EXPORT_LIMIT + 1,
  );
});

test("export reflects updates using stable UID and incremented SEQUENCE", async () => {
  const event = await createEvent(app.collections.events, input, alice);
  const patch = await app.inject({
    method: "PATCH",
    url: `/events/${event._id}`,
    headers: { ...headers, "if-match": '"1"' },
    payload: { title: "Updated" },
  });
  assert.equal(patch.statusCode, 200, patch.payload);
  const response = await app.inject({ url: "/events/export.ics", headers });
  const entry = entries(response.payload)[0];
  assert.equal(entry?.getFirstPropertyValue("uid"), event.uid);
  assert.equal(entry?.getFirstPropertyValue("summary"), "Updated");
  assert.equal(entry?.getFirstPropertyValue("sequence"), 1);
});

test("OpenAPI documents calendar content type, authentication and export errors", () => {
  const operation = app.swagger().paths?.["/events/export.ics"]?.get;
  assert.ok(operation);
  assert.deepStrictEqual(operation.security, [{ Auth: [] }]);
  for (const status of ["200", "400", "401", "413", "429"])
    assert.ok(operation.responses?.[status]);
  const success = operation.responses?.["200"];
  assert.ok(
    success && "content" in success && success.content?.["text/calendar"],
  );
});

test("export shares the authenticated read budget with JSON listing", async () => {
  const limited = Fastify({ pluginTimeout: 300000 });
  onTestFinished(() => limited.close());
  await limited.register(fp(App), {
    test: true,
    authSkip: false,
    mongoUri: undefined,
    mongoTestUri: undefined,
    rateLimitReadMax: 1,
  });
  await limited.ready();
  assert.equal(
    (await limited.inject({ url: "/events", headers })).statusCode,
    200,
  );
  const response = await limited.inject({ url: "/events/export.ics", headers });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["x-ratelimit-scope"], "user-read");
  assert.ok(Number(response.headers["retry-after"]) > 0);
  assert.equal(
    (
      await limited.inject({
        url: "/events/export.ics",
        headers: { authorization: "Bearer bob-dev-token" },
      })
    ).statusCode,
    200,
  );
});

test("fractional-second schedules round outwards to a positive ICS interval", async () => {
  await createEvent(
    app.collections.events,
    {
      ...input,
      schedule: {
        kind: "timed",
        startsAt: "2026-10-05T02:00:00.100Z",
        endsAt: "2026-10-05T02:00:00.200Z",
      },
    },
    alice,
  );
  const response = await app.inject({ url: "/events/export.ics", headers });
  const entry = entries(response.payload)[0];
  assert.equal(
    entry?.getFirstPropertyValue("dtstart")?.toString(),
    "2026-10-05T02:00:00Z",
  );
  assert.equal(
    entry?.getFirstPropertyValue("dtend")?.toString(),
    "2026-10-05T02:00:01Z",
  );
});
