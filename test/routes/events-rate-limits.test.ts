import { onTestFinished, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import fp from "fastify-plugin";
import App from "../../src/app.js";

async function build() {
  const app = Fastify({ pluginTimeout: 300000 });
  onTestFinished(() => app.close());
  await app.register(fp(App), {
    mongoUri: undefined,
    mongoTestUri: undefined,
    test: true,
    authSkip: false,
    rateLimitWriteMax: 1,
  });
  await app.ready();
  return app;
}

const headers = { authorization: "Bearer alice-dev-token" };
const payload = {
  title: "Study",
  eventType: "study",
  allowConflicts: false,
  schedule: { kind: "all-day", startsOn: "2026-10-05", endsOn: "2026-10-06" },
};

test("POST, PATCH and DELETE share the write budget; denied requests cannot mutate MongoDB", async () => {
  const app = await build();
  const created = await app.inject({
    method: "POST",
    url: "/events",
    headers,
    payload,
  });
  assert.equal(created.statusCode, 201, created.payload);
  const id = created.json().id;
  const before = await app.collections.events.find({}).toArray();
  const requests = [
    app.inject({ method: "POST", url: "/events", headers, payload }),
    app.inject({
      method: "PATCH",
      url: `/events/${id}`,
      headers: { ...headers, "if-match": '"1"' },
      payload: { title: "Changed" },
    }),
    app.inject({
      method: "DELETE",
      url: `/events/${id}`,
      headers: { ...headers, "if-match": '"1"' },
    }),
  ];
  const responses = await Promise.all(requests);
  for (const response of responses) {
    assert.equal(response.statusCode, 429, response.payload);
    assert.equal(response.headers["x-ratelimit-scope"], "user-write");
    assert.ok(Number(response.headers["retry-after"]) > 0);
  }
  assert.deepStrictEqual(
    await app.collections.events.find({}).toArray(),
    before,
  );
  assert.equal((await app.inject({ url: "/events", headers })).statusCode, 200);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/events",
        headers: { authorization: "Bearer bob-dev-token" },
        payload,
      })
    ).statusCode,
    201,
  );
  const path =
    app.swagger().paths?.["/events/"] ?? app.swagger().paths?.["/events"];
  assert.ok(path?.post?.responses?.["429"]);
});

test("invalid authenticated writes consume budget before validation", async () => {
  const app = await build();
  assert.equal(
    (await app.inject({ method: "POST", url: "/events", headers, payload: {} }))
      .statusCode,
    400,
  );
  const denied = await app.inject({
    method: "POST",
    url: "/events",
    headers,
    payload,
  });
  assert.equal(denied.statusCode, 429);
  assert.equal(await app.collections.events.countDocuments(), 0);
});
