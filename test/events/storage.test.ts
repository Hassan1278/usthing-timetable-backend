import { onTestFinished, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { ObjectId } from "mongodb";
import App from "../../src/app.js";
import { users } from "../../src/auth/users.js";
import type { EventDocument } from "../../src/events/domain/model.js";

async function buildApp() {
  const app = Fastify({ pluginTimeout: 5 * 60 * 1000 });
  onTestFinished(() => app.close());
  await app.register(fp(App), {
    mongoUri: undefined,
    mongoTestUri: undefined,
    authSkip: false,
    test: true,
  });
  await app.ready();
  return app;
}

function storedEvent(ownerId: string, uid: string): EventDocument {
  return {
    _id: new ObjectId(),
    ownerId,
    uid,
    title: "Study session",
    eventType: "study",
    allowConflicts: false,
    schedule: {
      kind: "timed",
      startsAt: new Date("2026-10-05T10:00:00+08:00"),
      endsAt: new Date("2026-10-05T11:00:00+08:00"),
    },
    emailNotifications: { enabled: false },
    revision: 1,
    createdAt: new Date("2026-09-23T00:00:00Z"),
    updatedAt: new Date("2026-09-23T00:00:00Z"),
  };
}

test("events collection preserves timed instants and all-day dates", async () => {
  const app = await buildApp();
  const alice = users.find((user) => user.username === "alice");
  assert.ok(alice);
  const timed = storedEvent(alice.id, "timed-event");
  const allDay: EventDocument = {
    ...storedEvent(alice.id, "all-day-event"),
    schedule: {
      kind: "all-day",
      startsOn: "2026-10-05",
      endsOn: "2026-10-06",
    },
  };

  await app.collections.events.insertMany([timed, allDay]);
  assert.deepStrictEqual(
    await app.collections.events.findOne({ _id: timed._id, ownerId: alice.id }),
    timed,
  );
  assert.deepStrictEqual(
    await app.collections.events.findOne({
      _id: allDay._id,
      ownerId: alice.id,
    }),
    allDay,
  );
});

test("calendar UIDs are unique per owner, not across users", async () => {
  const app = await buildApp();
  const alice = users.find((user) => user.username === "alice");
  const bob = users.find((user) => user.username === "bob");
  assert.ok(alice);
  assert.ok(bob);

  await app.collections.events.insertOne(storedEvent(alice.id, "shared-uid"));
  await assert.rejects(
    app.collections.events.insertOne(storedEvent(alice.id, "shared-uid")),
    { code: 11000 },
  );
  await app.collections.events.insertOne(storedEvent(bob.id, "shared-uid"));
  await app.collections.events.insertOne(storedEvent(alice.id, "another-uid"));
  assert.equal(
    await app.collections.events.countDocuments({ ownerId: alice.id }),
    2,
  );
  assert.equal(
    await app.collections.events.countDocuments({ ownerId: bob.id }),
    1,
  );
});
