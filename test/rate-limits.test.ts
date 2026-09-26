import { onTestFinished, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import { users } from "../src/auth/users.js";
import Auth from "../src/plugins/auth.js";
import { mongoPlugin } from "../src/plugins/init-mongo.js";
import RateLimits, { type RateLimitOptions } from "../src/rate-limits.js";

async function build(options: RateLimitOptions = {}) {
  const app = Fastify();
  onTestFinished(() => app.close());
  await app.register(mongoPlugin, {
    databaseName: "rate-limit-tests",
    test: true,
  });
  await app.register(RateLimits, options);
  const alice = users.find((user) => user.username === "alice");
  assert.ok(alice);
  await app.register(Auth, {
    users: [...users, { ...alice, token: "alice-second-token" }],
  });
  app.get("/public", async () => "public");
  await app.withAuth(async (scope) => {
    scope.get("/one", async () => "one");
    scope.get("/two", async () => "two");
    scope.post("/write", async () => "created");
  });
  await app.ready();
  return app;
}

test("IP allowance covers routes and unknown URLs before authentication", async () => {
  const app = await build({ rateLimitIpMax: 2 });
  assert.equal((await app.inject({ url: "/one" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/does-not-exist" })).statusCode, 404);
  const denied = await app.inject({
    url: "/two",
    headers: { authorization: "bad header" },
  });
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.headers["x-ratelimit-scope"], "ip");
  assert.equal(denied.headers["x-ratelimit-remaining"], "0");
  assert.ok(Number(denied.headers["retry-after"]) > 0);
  assert.equal(denied.json().error, "Too Many Requests");
  assert.equal(
    (await app.inject({ url: "/public", remoteAddress: "192.0.2.1" }))
      .statusCode,
    200,
  );
});

test("forged forwarding headers do not bypass the IP limit", async () => {
  const app = await build({ rateLimitIpMax: 1 });
  assert.equal(
    (
      await app.inject({
        url: "/public",
        headers: { "x-forwarded-for": "192.0.2.1" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        url: "/public",
        headers: { "x-forwarded-for": "192.0.2.2" },
      })
    ).statusCode,
    429,
  );
});

test("IPv6 addresses in one subnet share the IP allowance", async () => {
  const app = await build({ rateLimitIpMax: 1 });
  assert.equal(
    (await app.inject({ url: "/public", remoteAddress: "2001:db8::1" }))
      .statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: "/public", remoteAddress: "2001:db8::2" }))
      .statusCode,
    429,
  );
});

test("read allowance follows user ID across IPs, tokens and endpoints", async () => {
  const app = await build({ rateLimitReadMax: 1 });
  const first = await app.inject({
    url: "/one",
    remoteAddress: "192.0.2.1",
    headers: { authorization: "Bearer alice-dev-token" },
  });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({
    url: "/two",
    remoteAddress: "192.0.2.2",
    headers: { authorization: "Bearer alice-second-token" },
  });
  assert.equal(second.statusCode, 429);
  assert.equal(second.headers["x-ratelimit-scope"], "user-read");
  assert.equal(
    (
      await app.inject({
        url: "/two",
        headers: { authorization: "Bearer bob-dev-token" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/write",
        headers: { authorization: "Bearer alice-dev-token" },
      })
    ).statusCode,
    200,
  );
});

test("HEAD shares the read allowance", async () => {
  const app = await build({ rateLimitReadMax: 1 });
  const headers = { authorization: "Bearer alice-dev-token" };
  assert.equal(
    (await app.inject({ method: "HEAD", url: "/one", headers })).statusCode,
    200,
  );
  assert.equal((await app.inject({ url: "/two", headers })).statusCode, 429);
});

test("concurrent requests cannot exceed a user's allowance", async () => {
  const app = await build({ rateLimitReadMax: 3 });
  const responses = await Promise.all(
    Array.from({ length: 10 }, () =>
      app.inject({
        url: "/one",
        headers: { authorization: "Bearer alice-dev-token" },
      }),
    ),
  );
  assert.equal(
    responses.filter((response) => response.statusCode === 200).length,
    3,
  );
  assert.equal(
    responses.filter((response) => response.statusCode === 429).length,
    7,
  );
});

test("requests succeed again when the window expires", async () => {
  const app = await build({ rateLimitIpMax: 1, rateLimitWindowMs: 1000 });
  assert.equal((await app.inject({ url: "/public" })).statusCode, 200);
  assert.equal((await app.inject({ url: "/public" })).statusCode, 429);
  await Bun.sleep(1100);
  assert.equal((await app.inject({ url: "/public" })).statusCode, 200);
});

test("default budgets are 120 IP, 120 reads and 30 writes per minute", async () => {
  const app = await build();
  const publicResponse = await app.inject({ url: "/public" });
  assert.equal(publicResponse.headers["x-ratelimit-limit"], "120");
  assert.equal(publicResponse.headers["x-ratelimit-reset"], "60");
  const headers = { authorization: "Bearer alice-dev-token" };
  const read = await app.inject({ url: "/one", headers });
  assert.equal(read.headers["x-ratelimit-limit"], "120");
  const write = await app.inject({ method: "POST", url: "/write", headers });
  assert.equal(write.headers["x-ratelimit-limit"], "30");
});
