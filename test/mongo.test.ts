// Proves the default MongoDB wiring: with no MONGO_URI configured, building
// the app spawns an in-memory MongoDB and prepares the `events` collection —
// no external services needed.
//
// The app plugin is wrapped in `fastify-plugin` at the registration site (the
// same pattern the production dev scripts use) so the decorators added by the
// autoloaded plugins (`fastify.collections`, `fastify.mongo`) collapse onto
// this root instance: fastify-cli's `helper.build` keeps them scoped inside
// the autoloader, invisible to the instance it returns.

import { onTestFinished, spyOn, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import fp from "fastify-plugin";
import App from "../src/app.js";

test("the app reports ready with the collections decorated", async () => {
  const app = Fastify({ pluginTimeout: 5 * 60 * 1000 });
  onTestFinished(() => app.close());

  await app.register(fp(App), {
    mongoUri: undefined,
    mongoTestUri: undefined,
    authSkip: true,
  });
  await app.ready();

  assert.ok(app.collections.events);
  assert.deepStrictEqual(Object.keys(app.collections), ["events"]);
  assert.equal(app.mongo.db?.databaseName, "template-api");
  for (const url of ["/example", "/example/error", "/auth-example"]) {
    assert.equal((await app.inject({ url })).statusCode, 404);
    assert.ok(!app.swagger().paths?.[url]);
  }
  assert.ok(typeof app.withAuth === "function");
  const healthy = await app.inject({ url: "/health" });
  assert.equal(healthy.statusCode, 200);
  assert.deepStrictEqual(healthy.json(), { status: "ok" });
  assert.ok(app.mongo.db);
  const command = spyOn(app.mongo.db, "command").mockRejectedValueOnce(
    new Error("private connection details"),
  );
  try {
    const unavailable = await app.inject({ url: "/health" });
    assert.equal(unavailable.statusCode, 503);
    assert.deepStrictEqual(unavailable.json(), { status: "unavailable" });
  } finally {
    command.mockRestore();
  }
});
