import { onTestFinished, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import fp from "fastify-plugin";
import App from "../src/app.js";
import { seedUserProfiles } from "../src/auth/user-store.js";
import { users } from "../src/auth/users.js";

async function buildApp(mongoUri?: string) {
  const app = Fastify({ pluginTimeout: 300000 });
  onTestFinished(() => app.close());
  await app.register(fp(App), {
    mongoUri,
    mongoTestUri: undefined,
    authSkip: false,
  });
  await app.ready();
  return app;
}
const headers = { authorization: "Bearer alice-dev-token" };
const payload = {
  title: "Appointment",
  eventType: "appointment",
  allowConflicts: true,
  schedule: {
    kind: "timed",
    startsAt: "2031-10-05T10:00:00+08:00",
    endsAt: "2031-10-05T11:00:00+08:00",
  },
  recurrence: { frequency: "daily", endsOn: "2031-10-06" },
};

test("internal profiles persist emails without tokens and seeding preserves saved addresses", async () => {
  const app = await buildApp();
  assert.equal(await app.collections.users.countDocuments(), 2);
  for (const user of users) {
    assert.deepStrictEqual(
      await app.collections.users.findOne({ _id: user.id }),
      {
        _id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
      },
    );
  }
  const alice = users[0]!;
  await app.collections.users.updateOne(
    { _id: alice.id },
    {
      $set: { email: "alice.updated@example.invalid" },
    },
  );
  await seedUserProfiles(app.collections.users, users);
  assert.equal(await app.collections.users.countDocuments(), 2);
  assert.equal(
    (await app.collections.users.findOne({ _id: alice.id }))?.email,
    "alice.updated@example.invalid",
  );
  await assert.rejects(
    seedUserProfiles(app.collections.users, [
      { ...alice, email: "invalid-email" },
    ]),
    /Invalid internal user profile/,
  );
  assert.equal(
    (await app.collections.users.findOne({ _id: alice.id }))?.email,
    "alice.updated@example.invalid",
  );
});

test("recipient emails are private and enabled preferences survive application restart", async () => {
  const app = await buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/events",
    headers,
    payload,
  });
  assert.equal(created.statusCode, 201, created.payload);
  const event = created.json();
  assert.deepStrictEqual(event.emailNotifications, {
    enabled: true,
    minutesBefore: [1440, 120],
  });
  const uri = `mongodb://${app.mongo.client.options.hosts[0]}/${app.mongo.db!.databaseName}`;
  const restarted = await buildApp(uri);
  const read = await restarted.inject({ url: `/events/${event.id}`, headers });
  assert.equal(read.statusCode, 200, read.payload);
  assert.deepStrictEqual(
    read.json().emailNotifications,
    event.emailNotifications,
  );
  assert.equal(read.json().revision, 1);
  const responses = [
    created,
    read,
    await restarted.inject({
      url: "/events?from=2031-10-05&to=2031-10-07",
      headers,
    }),
    await restarted.inject({ url: "/events/export.ics", headers }),
  ];
  for (const response of responses) {
    assert.ok(response.statusCode < 300, response.payload);
    for (const user of users) assert.ok(!response.payload.includes(user.email));
  }
  assert.equal(
    "email" in (await restarted.authenticate("alice-dev-token")),
    false,
  );
  assert.equal(
    (await restarted.inject({ url: "/users", headers })).statusCode,
    404,
  );
  for (const body of [
    { ...payload, email: "client@example.invalid" },
    {
      ...payload,
      emailNotifications: { enabled: true, email: "client@example.invalid" },
    },
  ]) {
    const response = await restarted.inject({
      method: "POST",
      url: "/events",
      headers,
      payload: body,
    });
    assert.equal(response.statusCode, 400, response.payload);
  }
  for (const url of [
    `/events/${event.id}`,
    `/events/${event.id}/occurrences?originalStart=2031-10-05T02:00:00Z`,
  ]) {
    const response = await restarted.inject({
      method: "PATCH",
      url,
      headers: { ...headers, "if-match": '"1"' },
      payload: { email: "client@example.invalid" },
    });
    assert.equal(response.statusCode, 400, response.payload);
  }
  assert.equal(await restarted.collections.events.countDocuments(), 1);
  assert.equal(
    (await restarted.inject({ url: `/events/${event.id}`, headers })).json()
      .revision,
    1,
  );
});
