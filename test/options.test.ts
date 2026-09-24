import { describe, expect, test } from "bun:test";
import { loadOptions } from "../src/options.js";

describe("loadOptions", () => {
  test("loads configurable rate limits", () => {
    const options = loadOptions({
      RATE_LIMIT_IP_MAX: "200",
      RATE_LIMIT_READ_MAX: "100",
      RATE_LIMIT_WRITE_MAX: "20",
      RATE_LIMIT_WINDOW_MS: "30000",
    });
    expect(options.rateLimitIpMax).toBe(200);
    expect(options.rateLimitReadMax).toBe(100);
    expect(options.rateLimitWriteMax).toBe(20);
    expect(options.rateLimitWindowMs).toBe(30000);
  });

  test.each([
    "RATE_LIMIT_IP_MAX",
    "RATE_LIMIT_READ_MAX",
    "RATE_LIMIT_WRITE_MAX",
    "RATE_LIMIT_WINDOW_MS",
  ])("rejects invalid %s", (name) => {
    for (const value of ["0", "-1", "1.5", "1e3", "abc", "9007199254740992"]) {
      expect(() => loadOptions({ [name]: value })).toThrow(name);
    }
  });
  test("loads options from an explicit env object", () => {
    const options = loadOptions({
      MONGO_URI: "mongodb://localhost:27017/template-api-test",
      MONGO_TEST_URI: "mongodb://localhost:27018/template-api-test",
      AUTH_SKIP: "true",
    });

    expect(options.pluginTimeout).toBe(5 * 60 * 1000);
    expect(options.test).toBe(false);
    expect(options.mongoUri).toBe(
      "mongodb://localhost:27017/template-api-test",
    );
    expect(options.mongoTestUri).toBe(
      "mongodb://localhost:27018/template-api-test",
    );
    expect(options.authSkip).toBe(true);
  });

  test("parses AUTH_SKIP=false as false", () => {
    const options = loadOptions({ AUTH_SKIP: "false" });

    expect(options.authSkip).toBe(false);
  });

  test("blank mongo URIs count as unset", () => {
    // Candidates blank a variable in .env to "remove" it; the in-memory
    // fallback must kick in rather than crash startup.
    const options = loadOptions({
      MONGO_URI: "",
      MONGO_TEST_URI: "   ",
    });

    expect(options.mongoUri).toBeUndefined();
    expect(options.mongoTestUri).toBeUndefined();
  });

  test("leaves every option unset by default", () => {
    const options = loadOptions({});

    // The Mongo URIs are undefined when unset; init-mongo resolves the
    // default (production) or in-memory fallback at runtime.
    expect(options.mongoUri).toBeUndefined();
    expect(options.mongoTestUri).toBeUndefined();
    expect(options.authSkip).toBeUndefined();
  });

  test("loading with an empty env succeeds", () => {
    // There are no required environment variables; every option is optional.
    expect(() => loadOptions({})).not.toThrow();
  });
});
