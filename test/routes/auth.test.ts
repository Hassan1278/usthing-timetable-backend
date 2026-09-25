import { onTestFinished, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import AuthPlugin, { type AuthPluginOptions } from "../../src/plugins/auth.js";
import Sensible from "../../src/plugins/sensible.js";

// Register test-only probe routes on a bare Fastify instance. `authSkip` defaults to false, so scoped requests must present one
// of the bearer tokens defined in src/auth/users.ts.
async function buildAuthApp(options: AuthPluginOptions = {}) {
  const app = Fastify();
  await app.register(AuthPlugin, options);
  await app.register(Sensible);
  app.withAuth(async (scope) => {
    scope.get("/protected", async (request) => request.user.username);
  });
  app.get("/public", async () => "public");
  await app.ready();
  return app;
}
test("authentication returns a stable public identity", async () => {
  const app = await buildAuthApp();
  onTestFinished(() => app.close());

  const firstAlice = await app.authenticate("alice-dev-token");
  const secondAlice = await app.authenticate("alice-dev-token");
  const bob = await app.authenticate("bob-dev-token");

  assert.equal(firstAlice.id, "0f5551bd-10be-41dc-bd28-827ed4b49a67");
  assert.equal(secondAlice.id, firstAlice.id);
  assert.notEqual(bob.id, firstAlice.id);

  assert.deepEqual(firstAlice, {
    id: "0f5551bd-10be-41dc-bd28-827ed4b49a67",
    username: "alice",
    name: "Alice",
  });
  assert.ok(!("token" in firstAlice));
  assert.ok(!("email" in firstAlice));
});
test("protected route rejects missing credentials", async () => {
  const app = await buildAuthApp();
  onTestFinished(() => app.close());

  const res = await app.inject({
    url: "/protected",
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload, "Missing Authorization Header");
});

test("unknown tokens are rejected", async () => {
  const app = await buildAuthApp();
  onTestFinished(() => app.close());

  const res = await app.inject({
    url: "/protected",
    headers: { authorization: "Bearer not-a-known-token" },
  });
  assert.equal(res.statusCode, 401);
});

test("malformed authorization headers return a bad request", async () => {
  const app = await buildAuthApp();
  onTestFinished(() => app.close());

  const res = await app.inject({
    url: "/protected",
    headers: { authorization: "foo" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload, "Invalid Authorization Header");
});

test("valid bearer token reaches the handler", async () => {
  const app = await buildAuthApp();
  onTestFinished(() => app.close());

  const res = await app.inject({
    url: "/protected",
    headers: { authorization: "Bearer alice-dev-token" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload, "alice");
});

test("public routes stay open while the protected route requires auth", async () => {
  const app = await buildAuthApp();
  onTestFinished(() => app.close());

  const res = await app.inject({
    url: "/public",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload, "public");
});

test("authSkip is a true bypass: any header authenticates as anonymous", async () => {
  const app = await buildAuthApp({ authSkip: true });
  onTestFinished(() => app.close());

  // No header at all.
  const noHeader = await app.inject({ url: "/protected" });
  assert.equal(noHeader.statusCode, 200);
  assert.equal(noHeader.payload, "anonymous");

  // A stale token left in an HTTP client must not 401 under skip.
  const staleToken = await app.inject({
    url: "/protected",
    headers: { authorization: "Bearer alice-dev-token" },
  });
  assert.equal(staleToken.statusCode, 200);
  assert.equal(staleToken.payload, "anonymous");

  // A garbage header must not 401 under skip either.
  const garbage = await app.inject({
    url: "/protected",
    headers: { authorization: "Bearer not-a-known-token" },
  });
  assert.equal(garbage.statusCode, 200);
  assert.equal(garbage.payload, "anonymous");

  assert.equal(noHeader.headers["x-auth-skip"], "true");
});
