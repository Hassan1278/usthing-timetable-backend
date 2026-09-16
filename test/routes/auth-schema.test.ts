// Pins the `fastify.withAuth` schema-merging contract: scoped routes document
// the auth 401 automatically, a route's own 400 is preserved (merged, not
// replaced), and validation failures still return Fastify's standard JSON
// error body instead of an auth literal.

import { onTestFinished, test } from "bun:test";
import * as assert from "node:assert";
import swagger from "@fastify/swagger";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import Fastify from "fastify";
import { Type } from "typebox";
import AuthPlugin from "../../src/plugins/auth.js";
import Sensible from "../../src/plugins/sensible.js";

/**
 * Extracts a GET route's documented responses from the OpenAPI document,
 * failing the test with a clear message instead of tripping over
 * `noUncheckedIndexedAccess`.
 */
function getResponses(
  app: FastifyInstance,
  path: string,
): Record<string, unknown> {
  const paths = app.swagger().paths;
  if (paths === undefined) {
    throw new Error("openapi document has no paths");
  }
  const item = paths[path];
  if (item === undefined || !("get" in item) || item.get === undefined) {
    throw new Error(`expected a GET route for ${path}`);
  }
  const responses: unknown = item.get.responses;
  if (responses === null || typeof responses !== "object") {
    throw new Error(`expected documented responses for GET ${path}`);
  }
  // Response objects are string-keyed maps of schema objects.
  return responses as Record<string, unknown>;
}

/**
 * Digs the JSON schema out of an OpenAPI response object
 * (`{ content: { "application/json": { schema } } }`).
 */
function jsonSchemaOf(response: unknown): unknown {
  if (
    typeof response !== "object" ||
    response === null ||
    !("content" in response)
  ) {
    throw new Error("expected an OpenAPI response object with content");
  }
  const content: unknown = response.content;
  if (
    typeof content !== "object" ||
    content === null ||
    !("application/json" in content)
  ) {
    throw new Error("expected application/json content");
  }
  const media: unknown = content["application/json"];
  if (typeof media !== "object" || media === null || !("schema" in media)) {
    throw new Error("expected a JSON schema");
  }
  return media.schema;
}

const routes: FastifyPluginAsync = async (fastify) => {
  await fastify.withAuth(async (scope) => {
    // Request validation, but no declared 400: withAuth must not install an
    // auth-only 400 schema here, leaving validation errors undocumented
    // rather than narrowed to auth header literals.
    scope.get(
      "/validated",
      {
        schema: {
          querystring: Type.Object({ page: Type.Number() }),
          response: { 200: Type.String() },
        },
      },
      async () => "ok",
    );

    // Declares its own 400: merged with the auth literals as a oneOf.
    scope.get(
      "/own-400",
      {
        schema: {
          querystring: Type.Object({ page: Type.Number() }),
          response: {
            200: Type.String(),
            400: Type.String({ description: "Other bad-request cases." }),
          },
        },
      },
      async () => "ok",
    );
  });
};

async function buildSchemaApp() {
  const app = Fastify();
  await app.register(AuthPlugin);
  await app.register(Sensible);
  await app.register(swagger, {
    openapi: { info: { title: "test", version: "0.0.0" } },
  });
  await app.register(routes);
  await app.ready();
  return app;
}

test("scoped routes document the auth 401 and no implicit 400", async () => {
  const app = await buildSchemaApp();
  onTestFinished(() => app.close());

  const responses = getResponses(app, "/validated");
  assert.ok("401" in responses);
  assert.ok(!("400" in responses));
});

test("a route's own 400 is merged with the auth literals", async () => {
  const app = await buildSchemaApp();
  onTestFinished(() => app.close());

  const responses = getResponses(app, "/own-400");
  assert.ok("401" in responses);
  assert.ok("400" in responses);
  const schema400 = jsonSchemaOf(responses["400"]);
  assert.ok(
    typeof schema400 === "object" && schema400 !== null && "oneOf" in schema400,
  );
});

test("validation failures serialize as the standard error body", async () => {
  const app = await buildSchemaApp();
  onTestFinished(() => app.close());

  const res = await app.inject({
    url: "/validated?page=not-a-number",
    headers: { authorization: "Bearer alice-dev-token" },
  });
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.payload);
  assert.equal(body.error, "Bad Request");
});

test("missing credentials on a validated route still 401s", async () => {
  const app = await buildSchemaApp();
  onTestFinished(() => app.close());

  const res = await app.inject({ url: "/validated?page=1" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload, "Missing Authorization Header");
});
