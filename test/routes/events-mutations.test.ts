import { afterAll, beforeAll, beforeEach, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { ObjectId } from "mongodb";
import App from "../../src/app.js";
import type { EventResponse } from "../../src/events/response.js";

const app = Fastify({ pluginTimeout: 5 * 60 * 1000 });
const auth = { authorization: "Bearer alice-dev-token" };
const headers = { ...auth, "if-match": '"1"' };
let event: EventResponse;

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
  const response = await app.inject({
    method: "POST",
    url: "/events",
    headers: auth,
    payload: {
      title: "Appointment",
      description: "Bring notes",
      location: "Clinic",
      eventType: "appointment",
      allowConflicts: false,
      schedule: {
        kind: "timed",
        startsAt: "2026-10-05T10:00:00+08:00",
        endsAt: "2026-10-05T11:00:00+08:00",
      },
    },
  });
  assert.equal(response.statusCode, 201, response.payload);
  assert.equal(response.headers.etag, '"1"');
  event = response.json<EventResponse>();
});

async function stored() {
  return app.collections.events.findOne({ _id: new ObjectId(event.id) });
}

test("PATCH changes supplied fields, preserves metadata and returns the next ETag", async () => {
  const before = await stored();
  assert.ok(before);
  const response = await app.inject({
    method: "PATCH",
    url: `/events/${event.id}`,
    headers,
    payload: { title: "Updated", allowConflicts: true, location: "" },
  });
  assert.equal(response.statusCode, 200, response.payload);
  const body = response.json<EventResponse>();
  assert.deepStrictEqual(body, {
    ...event,
    title: "Updated",
    allowConflicts: true,
    location: "",
    revision: 2,
    updatedAt: body.updatedAt,
  });
  assert.equal(response.headers.etag, '"2"');
  const after = await stored();
  assert.ok(after);
  assert.equal(after.ownerId, before.ownerId);
  assert.equal(after.uid, before.uid);
  assert.deepStrictEqual(after.createdAt, before.createdAt);
  assert.ok(after.updatedAt.getTime() >= before.updatedAt.getTime());
  const get = await app.inject({ url: `/events/${event.id}`, headers: auth });
  assert.equal(get.headers.etag, '"2"');
  assert.deepStrictEqual(get.json(), body);
});

test("changing event type preserves existing reminders", async () => {
  const response = await app.inject({
    method: "PATCH",
    url: `/events/${event.id}`,
    headers,
    payload: { eventType: "class" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepStrictEqual(
    response.json().emailNotifications,
    event.emailNotifications,
  );
});

test("notification replacements resolve defaults, replace timings and allow disabling", async () => {
  const changes = [
    { enabled: true, minutesBefore: [30, 0] },
    { enabled: true },
    { enabled: false },
  ];
  const expected = [
    changes[0],
    { enabled: true, minutesBefore: [1440, 120] },
    changes[2],
  ];
  for (const [index, emailNotifications] of changes.entries()) {
    const response = await app.inject({
      method: "PATCH",
      url: `/events/${event.id}`,
      headers: { ...auth, "if-match": `"${index + 1}"` },
      payload: { emailNotifications },
    });
    assert.equal(response.statusCode, 200, response.payload);
    assert.deepStrictEqual(response.json().emailNotifications, expected[index]);
  }
});

test("replacing a timed schedule with all-day removes the old timed fields", async () => {
  const schedule = {
    kind: "all-day",
    startsOn: "2026-10-05",
    endsOn: "2026-10-06",
  };
  const response = await app.inject({
    method: "PATCH",
    url: `/events/${event.id}`,
    headers,
    payload: { schedule },
  });
  assert.equal(response.statusCode, 200, response.payload);
  assert.deepStrictEqual((await stored())?.schedule, schedule);
});

test.each([
  {},
  { title: " " },
  { allowConflicts: "true" },
  { description: null },
  { schedule: { endsAt: "2026-10-05T12:00:00+08:00" } },
  {
    schedule: {
      kind: "timed",
      startsAt: "2026-10-05T10:00:00+08:00",
      endsAt: "2026-10-05T09:00:00+08:00",
    },
  },
  {
    schedule: { kind: "all-day", startsOn: "2026-10-05", endsOn: "2026-10-05" },
  },
  {
    schedule: {
      kind: "all-day",
      startsOn: "2026-10-05",
      endsOn: "2026-10-06",
      timeZone: "Asia/Hong_Kong",
    },
  },
  { emailNotifications: { enabled: false, minutesBefore: [120] } },
  { emailNotifications: { enabled: true, minutesBefore: [] } },
])(
  "invalid PATCH %# leaves storage and revision unchanged",
  async (payload) => {
    const before = await stored();
    const response = await app.inject({
      method: "PATCH",
      url: `/events/${event.id}`,
      headers,
      payload,
    });
    assert.equal(response.statusCode, 400, response.payload);
    assert.deepStrictEqual(await stored(), before);
  },
);

test.each([
  "_id",
  "id",
  "ownerId",
  "uid",
  "revision",
  "createdAt",
  "updatedAt",
  "exceptions",
  "timeZone",
  "isOptional",
  "recurrence",
])("PATCH rejects protected or unsupported field %s", async (field) => {
  const before = await stored();
  const response = await app.inject({
    method: "PATCH",
    url: `/events/${event.id}`,
    headers,
    payload: { title: "Changed", [field]: "untrusted" },
  });
  assert.equal(response.statusCode, 400, response.payload);
  assert.deepStrictEqual(await stored(), before);
});

test.each(["PATCH", "DELETE"] as const)(
  "%s enforces auth, ownership and required revision",
  async (method) => {
    const before = await stored();
    const options = {
      method,
      url: `/events/${event.id}`,
      ...(method === "PATCH" ? { payload: { title: "Changed" } } : {}),
    };
    assert.equal((await app.inject(options)).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          ...options,
          headers: { ...headers, authorization: "Bearer unknown" },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ ...options, headers: auth })).statusCode,
      428,
    );
    const foreign = await app.inject({
      ...options,
      headers: { ...headers, authorization: "Bearer bob-dev-token" },
    });
    const missing = await app.inject({
      ...options,
      url: `/events/${new ObjectId()}`,
      headers,
    });
    assert.equal(foreign.statusCode, 404);
    assert.equal(missing.statusCode, 404);
    assert.deepStrictEqual(foreign.json(), missing.json());
    assert.equal(
      (await app.inject({ ...options, url: "/events/invalid", headers }))
        .statusCode,
      400,
    );
    assert.deepStrictEqual(await stored(), before);
  },
);

test.each(["1", '"0"', 'W/"1"', "*", '"1", "2"', '"9007199254740992"'])(
  "malformed revision %s cannot update or delete",
  async (match) => {
    const before = await stored();
    const requestHeaders = { ...auth, "if-match": match };
    const patch = await app.inject({
      method: "PATCH",
      url: `/events/${event.id}`,
      headers: requestHeaders,
      payload: { title: "Changed" },
    });
    const deletion = await app.inject({
      method: "DELETE",
      url: `/events/${event.id}`,
      headers: requestHeaders,
    });
    assert.equal(patch.statusCode, 400);
    assert.equal(deletion.statusCode, 400);
    assert.deepStrictEqual(await stored(), before);
  },
);

test("stale PATCH and DELETE cannot change a newer revision", async () => {
  const first = await app.inject({
    method: "PATCH",
    url: `/events/${event.id}`,
    headers,
    payload: { title: "New" },
  });
  assert.equal(first.statusCode, 200);
  const before = await stored();
  const stalePatch = await app.inject({
    method: "PATCH",
    url: `/events/${event.id}`,
    headers,
    payload: { title: "Stale" },
  });
  const staleDelete = await app.inject({
    method: "DELETE",
    url: `/events/${event.id}`,
    headers,
  });
  assert.equal(stalePatch.statusCode, 412);
  assert.equal(staleDelete.statusCode, 412);
  assert.deepStrictEqual(await stored(), before);
});

test("concurrent updates of one revision have exactly one winner", async () => {
  const responses = await Promise.all(
    ["First", "Second"].map((title) =>
      app.inject({
        method: "PATCH",
        url: `/events/${event.id}`,
        headers,
        payload: { title },
      }),
    ),
  );
  assert.deepStrictEqual(
    responses.map((response) => response.statusCode).sort(),
    [200, 412],
  );
  const winner = responses.find((response) => response.statusCode === 200);
  assert.equal((await stored())?.title, winner?.json().title);
  assert.equal((await stored())?.revision, 2);
});

test("an update racing deletion cannot delete a newer edit", async () => {
  const [patch, deletion] = await Promise.all([
    app.inject({
      method: "PATCH",
      url: `/events/${event.id}`,
      headers,
      payload: { title: "New" },
    }),
    app.inject({ method: "DELETE", url: `/events/${event.id}`, headers }),
  ]);
  if (patch.statusCode === 200) {
    assert.equal(deletion.statusCode, 412);
    assert.equal((await stored())?.revision, 2);
  } else {
    assert.equal(deletion.statusCode, 204);
    assert.ok([404, 412].includes(patch.statusCode));
    assert.equal(await stored(), null);
  }
});

test("DELETE returns an empty 204 and removes the event from reads", async () => {
  const response = await app.inject({
    method: "DELETE",
    url: `/events/${event.id}`,
    headers,
  });
  assert.equal(response.statusCode, 204, response.payload);
  assert.equal(response.payload, "");
  assert.equal(await stored(), null);
  assert.equal(
    (await app.inject({ url: `/events/${event.id}`, headers: auth }))
      .statusCode,
    404,
  );
  assert.deepStrictEqual(
    (await app.inject({ url: "/events", headers: auth })).json().items,
    [],
  );
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/events/${event.id}`,
        headers,
      })
    ).statusCode,
    404,
  );
});

test("PATCH validates the complete candidate, not just changed fields", async () => {
  await app.collections.events.updateOne(
    { _id: new ObjectId(event.id) },
    { $set: { "schedule.endsAt": new Date("2020-01-01") } },
  );
  const before = await stored();
  const response = await app.inject({
    method: "PATCH",
    url: `/events/${event.id}`,
    headers,
    payload: { title: "New" },
  });
  assert.equal(response.statusCode, 400);
  assert.deepStrictEqual(await stored(), before);
});

test("OpenAPI documents both mutation endpoints and revision errors", () => {
  const operations = app.swagger().paths?.["/events/{id}"];
  assert.ok(operations?.patch);
  assert.ok(operations?.delete);
  assert.ok(operations.patch.responses?.["412"]);
  assert.ok(operations.patch.responses?.["428"]);
  assert.ok(operations.delete.responses?.["204"]);
  assert.ok(operations.delete.responses?.["412"]);
});
