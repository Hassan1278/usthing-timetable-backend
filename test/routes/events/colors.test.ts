import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { ObjectId } from "mongodb";
import App from "../../../src/app.js";

const app = Fastify({ pluginTimeout: 300000 });
const auth = { authorization: "Bearer alice-dev-token" };
const payload = {
  title: "Colored event",
  eventType: "study",
  allowConflicts: true,
  schedule: {
    kind: "all-day",
    startsOn: "2026-10-05",
    endsOn: "2026-10-06",
  },
};
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
});
afterAll(() => app.close());
beforeEach(() => app.collections.events.deleteMany({}));
async function create(extra: object = {}) {
  const result = await app.inject({
    method: "POST",
    url: "/events",
    headers: auth,
    payload: { ...payload, ...extra },
  });
  expect(result.statusCode).toBe(201);
  return result.json();
}
async function patch(id: string, body: object, revision = 1, user = "alice") {
  return app.inject({
    method: "PATCH",
    url: `/events/${id}`,
    headers: {
      authorization: `Bearer ${user}-dev-token`,
      "if-match": `"${revision}"`,
    },
    payload: body,
  });
}

test.each([
  ["class", "#2563EB"],
  ["appointment", "#DC2626"],
  ["club", "#7C3AED"],
  ["study", "#16A34A"],
  ["personal", "#DB2777"],
  ["other", "#64748B"],
])("%s defaults to %s in storage and GET", async (eventType, color) => {
  const event = await create({ eventType });
  expect(event.color).toBe(color);
  const stored = await app.collections.events.findOne({
    _id: new ObjectId(event.id),
  });
  expect(stored?.color).toBe(color);
  const read = await app.inject({ url: `/events/${event.id}`, headers: auth });
  expect(read.json().color).toBe(color);
});

test("custom colors survive reads and category edits; PATCH is revision- and owner-protected", async () => {
  const event = await create({ color: "#aBc123" });
  expect(event.color).toBe("#aBc123");
  const changed = await patch(event.id, { eventType: "club" });
  expect(changed.statusCode).toBe(200);
  expect(changed.json().color).toBe("#aBc123");
  const recolored = await patch(event.id, { color: "#000000" }, 2);
  expect(recolored.statusCode).toBe(200);
  expect(recolored.json().color).toBe("#000000");
  expect((await patch(event.id, { color: "#FFFFFF" }, 2)).statusCode).toBe(412);
  expect(
    (await patch(event.id, { color: "#FFFFFF" }, 3, "bob")).statusCode,
  ).toBe(404);
  const list = await app.inject({ url: "/events", headers: auth });
  expect(list.json().items[0].color).toBe("#000000");
});

test.each([
  "red",
  "#abc",
  "#12345678",
  "#GG0000",
  "123456",
  "#123456\n",
  "",
  null,
  123,
])(
  "invalid color %j is rejected on create and patch without changing storage",
  async (color) => {
    const result = await app.inject({
      method: "POST",
      url: "/events",
      headers: auth,
      payload: { ...payload, color },
    });
    expect(result.statusCode).toBe(400);
    expect(await app.collections.events.countDocuments()).toBe(0);
    const event = await create();
    expect((await patch(event.id, { color })).statusCode).toBe(400);
    const stored = await app.collections.events.findOne({
      _id: new ObjectId(event.id),
    });
    expect(stored?.color).toBe("#16A34A");
    expect(stored?.revision).toBe(1);
  },
);

test("legacy documents get category defaults on reads and persist that color on the next edit", async () => {
  const event = await create();
  await app.collections.events.updateOne(
    { _id: new ObjectId(event.id) },
    { $unset: { color: "" } },
  );
  const read = await app.inject({ url: `/events/${event.id}`, headers: auth });
  expect(read.json().color).toBe("#16A34A");
  const range = await app.inject({
    url: "/events?from=2026-10-05&to=2026-10-07",
    headers: auth,
  });
  expect(range.json().items[0].color).toBe("#16A34A");
  const changed = await patch(event.id, { eventType: "club" });
  expect(changed.statusCode).toBe(200);
  expect(changed.json().color).toBe("#16A34A");
  expect(
    (await app.collections.events.findOne({ _id: new ObjectId(event.id) }))
      ?.color,
  ).toBe("#16A34A");
});

test("recurring occurrences inherit series color and allow one occurrence override", async () => {
  const event = await create({
    recurrence: { frequency: "daily", endsOn: "2026-10-06" },
  });
  const override = await app.inject({
    method: "PATCH",
    url: `/events/${event.id}/occurrences?originalStart=2026-10-05`,
    headers: { ...auth, "if-match": '"1"' },
    payload: { color: "#ABCDEF" },
  });
  expect(override.statusCode).toBe(200);
  expect((await patch(event.id, { color: "#123456" }, 2)).statusCode).toBe(200);
  const range = await app.inject({
    url: "/events?from=2026-10-05&to=2026-10-07",
    headers: auth,
  });
  expect(range.statusCode).toBe(200);
  const items = range.json().items;
  expect(
    items.find(
      (item: { originalStart: string }) => item.originalStart === "2026-10-05",
    ).color,
  ).toBe("#ABCDEF");
  expect(
    items.find(
      (item: { originalStart: string }) => item.originalStart === "2026-10-06",
    ).color,
  ).toBe("#123456");
});
