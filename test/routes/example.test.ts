import { onTestFinished, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import Sensible from "../../src/plugins/sensible.js";
import Example from "../../src/routes/example/index.js";

// The /example/error route references the `HttpError` shared schema registered
// by the sensible plugin, so register sensible before the example plugin.
test("example is loaded", async () => {
  const app = Fastify();
  onTestFinished(() => app.close());

  await app.register(Sensible);
  await app.register(Example, { prefix: "/example" });
  await app.ready();

  const res = await app.inject({
    url: "/example",
  });
  assert.equal(res.payload, "this is an example");
});

test("example error returns a bad request", async () => {
  const app = Fastify();
  onTestFinished(() => app.close());

  await app.register(Sensible);
  await app.register(Example, { prefix: "/example" });
  await app.ready();

  const res = await app.inject({
    url: "/example/error",
  });
  assert.equal(res.statusCode, 400);
});
