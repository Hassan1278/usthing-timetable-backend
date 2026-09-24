import { afterAll, beforeAll, beforeEach, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import fp from "fastify-plugin";
import ICAL from "ical.js";
import { ObjectId } from "mongodb";
import App from "../../src/app.js";

const app = Fastify({ pluginTimeout: 300000 });
const headers = { authorization: "Bearer alice-dev-token" };
const schedule = {
  kind: "timed",
  startsAt: "2026-10-05T18:00:00+08:00",
  endsAt: "2026-10-05T19:00:00+08:00",
};
const input = {
  title: "Club",
  eventType: "club",
  allowConflicts: false,
  schedule,
  recurrence: { frequency: "weekly", endsOn: "2027-10-05" },
};
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
});
afterAll(() => app.close());
beforeEach(() => app.collections.events.deleteMany({}));
async function create(
  payload: object = input,
  status = 201,
  token = "alice-dev-token",
) {
  const response = await app.inject({
    method: "POST",
    url: "/events",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
  assert.equal(response.statusCode, status, response.payload);
  return response.json();
}
async function list(from = "2026-10-12", to = "2026-10-19", extra = "") {
  const response = await app.inject({
    url: `/events?from=${from}&to=${to}${extra}`,
    headers,
  });
  assert.equal(response.statusCode, 200, response.payload);
  return response.json();
}
async function exception(
  id: string,
  originalStart: string,
  revision: number,
  method: "PATCH" | "DELETE" | "POST",
  payload?: object,
  status = 200,
) {
  const response = await app.inject({
    method,
    url: `/events/${id}/occurrences${method === "POST" ? "/restore" : ""}?originalStart=${encodeURIComponent(originalStart)}`,
    headers: { ...headers, "if-match": `"${revision}"` },
    ...(payload ? { payload } : {}),
  });
  assert.equal(response.statusCode, status, response.payload);
  return response.json();
}
async function patch(
  id: string,
  revision: number,
  payload: object,
  status = 200,
) {
  const response = await app.inject({
    method: "PATCH",
    url: `/events/${id}`,
    headers: { ...headers, "if-match": `"${revision}"` },
    payload,
  });
  assert.equal(response.statusCode, status, response.payload);
  return response.json();
}

for (const kind of ["timed", "all-day"]) {
  test(`${kind} series saves one document, resolves default and returns later occurrences`, async () => {
    const event = await create({
      ...input,
      schedule:
        kind === "timed"
          ? schedule
          : { kind: "all-day", startsOn: "2026-10-05", endsOn: "2026-10-06" },
      recurrence: { frequency: "daily" },
    });
    assert.equal(event.recurrence.endsOn, "2027-10-05");
    const page = await list();
    assert.equal(page.items.length, 7);
    assert.ok(
      page.items.every(
        (item: { id: string; originalStart: string }) =>
          item.id === event.id && item.originalStart.startsWith("2026-10"),
      ),
    );
    assert.equal(await app.collections.events.countDocuments(), 1);
    const unfiltered = await app.inject({ url: "/events", headers });
    assert.equal(unfiltered.json().items.length, 0);
    const stored = await app.inject({ url: `/events/${event.id}`, headers });
    assert.deepStrictEqual(stored.json().recurrence, event.recurrence);
  });
}

test("occurrence cursors paginate within a series without duplicates and exclude other owners", async () => {
  await create({
    ...input,
    recurrence: { frequency: "daily", endsOn: "2026-10-15" },
  });
  await create(input, 201, "bob-dev-token");
  let after = "";
  const starts: string[] = [];
  do {
    const page = await list(
      "2026-10-05",
      "2026-10-16",
      `&limit=2${after ? `&after=${encodeURIComponent(after)}` : ""}`,
    );
    starts.push(
      ...page.items.map(
        (item: { originalStart: string }) => item.originalStart,
      ),
    );
    after = page.nextCursor;
  } while (after);
  assert.equal(starts.length, 11);
  assert.equal(new Set(starts).size, 11);
});

test("full-series conflicts reject a collision beyond the 93-day calendar window", async () => {
  const { recurrence: _, ...single } = input;
  await create({
    ...single,
    schedule: {
      kind: "timed",
      startsAt: "2027-08-02T18:30:00+08:00",
      endsAt: "2027-08-02T19:30:00+08:00",
    },
  });
  await create(input, 409);
  assert.equal(await app.collections.events.countDocuments(), 1);
});

test("single-event writes detect existing recurring occurrences beyond 93 days", async () => {
  await create();
  const { recurrence: _, ...single } = input;
  await create(
    {
      ...single,
      schedule: {
        kind: "all-day",
        startsOn: "2027-08-02",
        endsOn: "2027-08-03",
      },
    },
    409,
  );
  await create({
    ...single,
    schedule: {
      kind: "timed",
      startsAt: "2027-08-02T19:00:00+08:00",
      endsAt: "2027-08-02T20:00:00+08:00",
    },
  });
});

test("series-to-series collisions and self-overlap are rejected; explicit conflict permission works", async () => {
  await create();
  await create(
    {
      ...input,
      schedule: {
        ...schedule,
        startsAt: "2027-05-03T18:30:00+08:00",
        endsAt: "2027-05-03T19:30:00+08:00",
      },
    },
    409,
  );
  await create({ ...input, allowConflicts: true });
  await app.collections.events.deleteMany({});
  const self = {
    ...input,
    schedule: { kind: "all-day", startsOn: "2026-10-05", endsOn: "2026-10-07" },
    recurrence: { frequency: "daily", endsOn: "2026-10-10" },
  };
  await create(self, 409);
  await create({ ...self, allowConflicts: true });
});

test("cancellation frees a slot, and restoration checks the newly occupied slot", async () => {
  const series = await create();
  const cancelled = await exception(
    series.id,
    "2026-10-12T18:00:00+08:00",
    1,
    "DELETE",
  );
  assert.equal(cancelled.revision, 2);
  assert.equal((await list()).items.length, 0);
  const { recurrence: _, ...single } = input;
  await create({
    ...single,
    schedule: {
      ...schedule,
      startsAt: "2026-10-12T18:00:00+08:00",
      endsAt: "2026-10-12T19:00:00+08:00",
    },
  });
  await exception(series.id, "2026-10-12T10:00:00Z", 2, "POST", undefined, 409);
  assert.equal(
    (await app.inject({ url: `/events/${series.id}`, headers })).json()
      .revision,
    2,
  );
});

test("an occurrence can be moved into another range without changing its identity", async () => {
  const series = await create();
  const moved = await exception(series.id, "2026-10-12T10:00:00Z", 1, "PATCH", {
    title: "Moved",
    schedule: {
      kind: "timed",
      startsAt: "2028-01-05T18:00:00+08:00",
      endsAt: "2028-01-05T19:00:00+08:00",
    },
  });
  assert.equal(moved.revision, 2);
  assert.equal((await list()).items.length, 0);
  const future = (await list("2028-01-05", "2028-01-06")).items;
  assert.equal(future.length, 1);
  assert.equal(future[0].originalStart, "2026-10-12T10:00:00.000Z");
  assert.equal(future[0].title, "Moved");
  const { recurrence: _, ...single } = input;
  await create({ ...single, schedule: future[0].schedule }, 409);
  await exception(series.id, "2026-10-12T10:00:00Z", 2, "POST");
  assert.equal((await list("2028-01-05", "2028-01-06")).items.length, 0);
  assert.equal((await list()).items.length, 1);
});

test("moving one occurrence onto another in its own series is rejected", async () => {
  const series = await create();
  await exception(
    series.id,
    "2026-10-12T10:00:00Z",
    1,
    "PATCH",
    {
      schedule: {
        kind: "timed",
        startsAt: "2026-10-19T18:00:00+08:00",
        endsAt: "2026-10-19T19:00:00+08:00",
      },
    },
    409,
  );
});

test("all-day cancellation and date override preserve the series schedule kind", async () => {
  const series = await create({
    ...input,
    schedule: { kind: "all-day", startsOn: "2026-10-05", endsOn: "2026-10-06" },
    recurrence: { frequency: "weekly", endsOn: "2026-10-19" },
  });
  await exception(series.id, "2026-10-12", 1, "PATCH", { schedule }, 400);
  await exception(series.id, "2026-10-12", 1, "PATCH", {
    schedule: { kind: "all-day", startsOn: "2026-10-13", endsOn: "2026-10-15" },
  });
  const items = (await list()).items;
  assert.equal(items[0].originalStart, "2026-10-12");
  assert.equal(items[0].schedule.startsOn, "2026-10-13");
  await exception(series.id, "2026-10-12", 2, "DELETE");
  assert.equal((await list()).items.length, 0);
});

test("whole-series metadata preserves resolved dates and exceptions; structural edits require explicit clearing", async () => {
  const series = await create();
  await exception(series.id, "2026-10-12T10:00:00Z", 1, "DELETE");
  const metadata = await patch(series.id, 2, { title: "Renamed" });
  assert.equal(metadata.recurrence.endsOn, "2027-10-05");
  assert.equal(metadata.exceptions.length, 1);
  await patch(series.id, 3, { recurrence: { frequency: "daily" } }, 400);
  const changed = await patch(series.id, 3, {
    recurrence: { frequency: "daily", endsOn: "2026-10-20" },
    clearExceptions: true,
  });
  assert.equal(changed.recurrence.frequency, "daily");
  assert.equal((await list()).items.length, 7);
  const normal = await patch(series.id, 4, { recurrence: null });
  assert.equal(normal.recurrence, undefined);
  assert.equal((await list()).items.length, 0);
  assert.equal(
    (await app.inject({ url: "/events", headers })).json().items.length,
    1,
  );
});

test("deleting a series removes its embedded exceptions in the same operation", async () => {
  const series = await create();
  await exception(series.id, "2026-10-12T10:00:00Z", 1, "DELETE");
  const response = await app.inject({
    method: "DELETE",
    url: `/events/${series.id}`,
    headers: { ...headers, "if-match": '"2"' },
  });
  assert.equal(response.statusCode, 204);
  assert.equal(await app.collections.events.countDocuments(), 0);
  assert.equal((await list()).items.length, 0);
});

test("exception operations enforce ownership, membership and revision", async () => {
  const series = await create();
  const url = `/events/${series.id}/occurrences?originalStart=2026-10-12T10:00:00Z`;
  for (const method of ["PATCH", "DELETE", "POST"] as const) {
    const target =
      method === "POST"
        ? url.replace("occurrences?", "occurrences/restore?")
        : url;
    const payload = method === "PATCH" ? { title: "Hacked" } : undefined;
    assert.equal(
      (
        await app.inject({
          method,
          url: target,
          ...(payload ? { payload } : {}),
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method,
          url: target,
          headers: { authorization: "Bearer bob-dev-token", "if-match": '"1"' },
          ...(payload ? { payload } : {}),
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method,
          url: target,
          headers,
          ...(payload ? { payload } : {}),
        })
      ).statusCode,
      428,
    );
  }
  await exception(
    series.id,
    "2026-10-13T10:00:00Z",
    1,
    "DELETE",
    undefined,
    404,
  );
  await exception(series.id, "2026-10-12", 1, "DELETE", undefined, 400);
  await exception(
    series.id,
    "2026-10-12T10:00:00Z",
    9,
    "DELETE",
    undefined,
    412,
  );
  for (const payload of [
    { ownerId: "bob" },
    { recurrence: { frequency: "daily" } },
    { allowConflicts: true },
    {},
    { schedule: { ...schedule, timeZone: "UTC" } },
  ])
    await exception(
      series.id,
      "2026-10-12T10:00:00Z",
      1,
      "PATCH",
      payload,
      400,
    );
  assert.equal(
    (await app.inject({ url: `/events/${series.id}`, headers })).json()
      .revision,
    1,
  );
});

test("concurrent exception and whole-series edits use the same revision lock", async () => {
  const series = await create();
  const results = await Promise.all([
    app.inject({
      method: "DELETE",
      url: `/events/${series.id}/occurrences?originalStart=2026-10-12T10:00:00Z`,
      headers: { ...headers, "if-match": '"1"' },
    }),
    app.inject({
      method: "PATCH",
      url: `/events/${series.id}`,
      headers: { ...headers, "if-match": '"1"' },
      payload: { title: "New" },
    }),
  ]);
  assert.deepStrictEqual(
    results.map((item) => item.statusCode).sort(),
    [200, 412],
  );
});

test("concurrent overlapping series creation has only one winner", async () => {
  const results = await Promise.all(
    [1, 2].map(() =>
      app.inject({ method: "POST", url: "/events", headers, payload: input }),
    ),
  );
  assert.deepStrictEqual(
    results.map((item) => item.statusCode).sort(),
    [201, 409],
  );
  assert.equal(await app.collections.events.countDocuments(), 1);
});

test("ICS recurrence, cancellation and moved override expand to the same effective schedules", async () => {
  const series = await create({
    ...input,
    recurrence: { frequency: "weekly", endsOn: "2026-10-26" },
  });
  await exception(series.id, "2026-10-12T10:00:00Z", 1, "DELETE");
  await exception(series.id, "2026-10-19T10:00:00Z", 2, "PATCH", {
    title: "Moved",
    schedule: {
      kind: "timed",
      startsAt: "2026-10-20T18:00:00+08:00",
      endsAt: "2026-10-20T19:00:00+08:00",
    },
  });
  const download = await app.inject({ url: "/events/export.ics", headers });
  assert.equal(download.statusCode, 200, download.payload);
  const components = new ICAL.Component(
    ICAL.parse(download.payload),
  ).getAllSubcomponents("vevent");
  const parent = components.find((item) => item.hasProperty("rrule"))!;
  const overrides = components.filter((item) =>
    item.hasProperty("recurrence-id"),
  );
  assert.equal(
    parent.getFirstPropertyValue("rrule")?.toString(),
    "FREQ=WEEKLY;COUNT=4",
  );
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0]?.getFirstPropertyValue("uid"), series.uid);
  assert.equal(
    overrides[0]?.getFirstPropertyValue("recurrence-id")?.toString(),
    "2026-10-19T10:00:00Z",
  );
  const event = new ICAL.Event(parent, { exceptions: overrides });
  const iterator = event.iterator();
  const starts: string[] = [];
  for (let next = iterator.next(); next; next = iterator.next())
    starts.push(
      event.getOccurrenceDetails(next).startDate.toJSDate().toISOString(),
    );
  const api = (await list("2026-10-01", "2026-11-01")).items;
  assert.deepStrictEqual(
    starts.sort(),
    api
      .map((item: { schedule: { startsAt: string } }) => item.schedule.startsAt)
      .sort(),
  );
});

test("all-day ICS keeps DATE recurrence IDs and moved dates", async () => {
  const series = await create({
    ...input,
    schedule: { kind: "all-day", startsOn: "2026-10-05", endsOn: "2026-10-06" },
    recurrence: { frequency: "daily", endsOn: "2026-10-07" },
  });
  await exception(series.id, "2026-10-06", 1, "DELETE");
  await exception(series.id, "2026-10-07", 2, "PATCH", {
    schedule: { kind: "all-day", startsOn: "2026-10-09", endsOn: "2026-10-10" },
  });
  const response = await app.inject({ url: "/events/export.ics", headers });
  assert.equal(response.statusCode, 200, response.payload);
  assert.match(response.payload, /EXDATE;VALUE=DATE:20261006/);
  assert.match(response.payload, /RECURRENCE-ID;VALUE=DATE:20261007/);
  assert.match(response.payload, /RRULE:FREQ=DAILY;COUNT=3/);
});

test("range export selects a series moved into that range and retains its complete rule", async () => {
  const series = await create();
  await exception(series.id, "2026-10-12T10:00:00Z", 1, "PATCH", {
    schedule: {
      kind: "timed",
      startsAt: "2028-01-01T10:00:00Z",
      endsAt: "2028-01-01T11:00:00Z",
    },
  });
  const response = await app.inject({
    url: "/events/export.ics?from=2028-01-01&to=2028-01-02",
    headers,
  });
  assert.equal(response.statusCode, 200, response.payload);
  assert.match(response.payload, /RRULE:FREQ=WEEKLY;COUNT=53/);
  assert.match(response.payload, /RECURRENCE-ID/);
});

test("calendar processing limits fail without returning a partial success", async () => {
  const series = await create({ ...input, allowConflicts: true });
  const seed = await app.collections.events.findOne({
    _id: new ObjectId(series.id),
  });
  assert.ok(seed);
  await app.collections.events.insertMany(
    Array.from({ length: 1000 }, (_, i) => ({
      ...seed,
      _id: new ObjectId(),
      uid: `budget-${i}`,
    })),
  );
  const response = await app.inject({
    url: "/events?from=2030-01-01&to=2030-01-02",
    headers,
  });
  assert.equal(response.statusCode, 413, response.payload);
  const { recurrence: _, ...single } = input;
  await create(
    {
      ...single,
      schedule: {
        kind: "all-day",
        startsOn: "2030-01-01",
        endsOn: "2030-01-02",
      },
    },
    413,
  );
  assert.equal(await app.collections.events.countDocuments(), 1001);
});

test("extending a whole series checks newly added distant occurrences", async () => {
  const series = await create({
    ...input,
    recurrence: { frequency: "weekly", endsOn: "2026-10-12" },
  });
  const { recurrence: _, ...single } = input;
  await create({
    ...single,
    schedule: {
      kind: "timed",
      startsAt: "2027-08-02T18:00:00+08:00",
      endsAt: "2027-08-02T19:00:00+08:00",
    },
  });
  await patch(
    series.id,
    1,
    { recurrence: { frequency: "weekly", endsOn: "2027-10-05" } },
    409,
  );
  assert.equal(
    (await app.inject({ url: `/events/${series.id}`, headers })).json()
      .revision,
    1,
  );
});

test("clearing exceptions restores intervals and cannot bypass conflicts", async () => {
  const series = await create();
  await exception(series.id, "2026-10-12T10:00:00Z", 1, "DELETE");
  const { recurrence: _, ...single } = input;
  await create({
    ...single,
    schedule: {
      kind: "timed",
      startsAt: "2026-10-12T10:00:00Z",
      endsAt: "2026-10-12T11:00:00Z",
    },
  });
  await patch(series.id, 2, { clearExceptions: true }, 409);
});

test("invalid recurrence bounds cannot be saved even when conflicts are allowed", async () => {
  for (const endsOn of ["2026-10-04", "2027-10-06"])
    await create(
      {
        ...input,
        allowConflicts: true,
        recurrence: { frequency: "daily", endsOn },
      },
      400,
    );
  assert.equal(await app.collections.events.countDocuments(), 0);
});

test("moving an occurrence onto a standalone event fails without changing the parent", async () => {
  const series = await create();
  const { recurrence: _, ...single } = input;
  const other = {
    kind: "timed",
    startsAt: "2026-10-13T10:00:00Z",
    endsAt: "2026-10-13T11:00:00Z",
  };
  await create({ ...single, schedule: other });
  await exception(
    series.id,
    "2026-10-12T10:00:00Z",
    1,
    "PATCH",
    { schedule: other },
    409,
  );
  assert.equal(
    (await app.inject({ url: `/events/${series.id}`, headers })).json()
      .exceptions,
    undefined,
  );
});

test("cancelled occurrences still count toward the expansion work budget", async () => {
  const { expandEvent, CalendarCapacityError } = await import(
    "../../src/events/series.js"
  );
  const series = await create({
    ...input,
    recurrence: { frequency: "daily", endsOn: "2026-10-07" },
  });
  const document = await app.collections.events.findOne({
    _id: new ObjectId(series.id),
  });
  assert.ok(document);
  document.exceptions = ["2026-10-05", "2026-10-06", "2026-10-07"].map(
    (date) => ({ originalStart: `${date}T10:00:00.000Z`, cancelled: true }),
  );
  assert.throws(
    () => expandEvent(document, { remaining: 2 }),
    CalendarCapacityError,
  );
  assert.deepStrictEqual(expandEvent(document, { remaining: 3 }), []);
});

test("cursors cannot supply owners or remove the required calendar window", async () => {
  const series = await create();
  for (const url of [
    `/events?after=${series.id}~2026-10-12T10:00:00.000Z`,
    `/events?from=2026-10-12&to=2026-10-19&after=${series.id}~2026`,
    "/events?from=2026-10-12&to=2026-10-19&ownerId=bob",
  ])
    assert.equal((await app.inject({ url, headers })).statusCode, 400);
});

test("mixed-schedule conflict checks remain correct at the supported year boundary", async () => {
  const { recurrence: _, ...single } = input;
  await create({
    ...single,
    schedule: { kind: "all-day", startsOn: "9999-12-30", endsOn: "9999-12-31" },
  });
  await create(
    {
      ...single,
      schedule: {
        kind: "timed",
        startsAt: "9999-12-30T23:30:00+08:00",
        endsAt: "9999-12-31T23:30:00+08:00",
      },
    },
    409,
  );
});
