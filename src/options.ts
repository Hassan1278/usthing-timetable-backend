import type { AutoloadPluginOptions } from "@fastify/autoload";
import type { FastifyServerOptions } from "fastify";
import type { AuthPluginOptions } from "./plugins/auth.js";
import type { InitMongoPluginOptions } from "./plugins/init-mongo.js";
import type { RateLimitOptions } from "./rate-limits.js";

export type Env = Record<string, string | undefined>;

type OptionArgs = {
  env: Env;
  envName: string;
  required: boolean;
};

function optionArgs(
  envOrEnvName: Env | string,
  envNameOrRequired?: string | boolean,
  required = true,
): OptionArgs {
  if (typeof envOrEnvName === "string") {
    return {
      env: Bun.env,
      envName: envOrEnvName,
      required:
        typeof envNameOrRequired === "boolean" ? envNameOrRequired : required,
    };
  }

  if (typeof envNameOrRequired !== "string") {
    throw new Error("Environment variable name is required");
  }

  return { env: envOrEnvName, envName: envNameOrRequired, required };
}

export type GetOption = {
  (envName: string): string;
  (envName: string, required: true): string;
  (envName: string, required: false): string | undefined;
  (envName: string, required: boolean): string | undefined;
  (env: Env, envName: string): string;
  (env: Env, envName: string, required: true): string;
  (env: Env, envName: string, required: false): string | undefined;
  (env: Env, envName: string, required: boolean): string | undefined;
};

export const getOption = function getOption(
  envOrEnvName: Env | string,
  envNameOrRequired?: string | boolean,
  required: boolean = true,
): string | undefined {
  const args = optionArgs(envOrEnvName, envNameOrRequired, required);
  const env = args.env[args.envName];
  if (env === undefined && args.required) {
    throw new Error(`Missing required environment variable: ${args.envName}`);
  }
  return env;
} as GetOption;

export type GetBooleanOption = {
  (envName: string): boolean | undefined;
  (envName: string, required: true): boolean | undefined;
  (envName: string, required: false): boolean | undefined;
  (envName: string, required: boolean): boolean | undefined;
  (env: Env, envName: string): boolean | undefined;
  (env: Env, envName: string, required: true): boolean | undefined;
  (env: Env, envName: string, required: false): boolean | undefined;
  (env: Env, envName: string, required: boolean): boolean | undefined;
};

export const getBooleanOption = function getBooleanOption(
  envOrEnvName: Env | string,
  envNameOrRequired?: string | boolean,
  required: boolean = true,
): boolean | undefined {
  const args = optionArgs(envOrEnvName, envNameOrRequired, required);
  const val = getOption(args.env, args.envName, args.required);
  if (val === undefined) return undefined;
  const normalized = val.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return undefined;
} as GetBooleanOption;

export function lazyOptions<T extends object>(loadOptions: () => T): T {
  let options: T | undefined;
  const getOptions = () => {
    options ??= loadOptions();
    return options;
  };

  return new Proxy({} as T, {
    get(_target, property) {
      return Reflect.get(getOptions(), property);
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        getOptions(),
        property,
      );
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(getOptions());
    },
    has(_target, property) {
      return property in getOptions();
    },
    ownKeys() {
      return Reflect.ownKeys(getOptions());
    },
    set(_target, property, value) {
      return Reflect.set(getOptions(), property, value);
    },
  });
}

export type AppOptions = {
  // Place your custom options for app below here.
  // Optional: Are we in tests?
  test?: boolean;
} & FastifyServerOptions &
  Partial<AutoloadPluginOptions> &
  InitMongoPluginOptions &
  AuthPluginOptions &
  RateLimitOptions;

function positiveIntegerOption(env: Env, name: string): number | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  const number = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number)) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return number;
}

export function loadOptions(env: Env = Bun.env): AppOptions {
  const options: AppOptions = {
    // Launching lots of services on the server,
    // especially at the same time by something such as docker compose up,
    // leads to slow startups.
    // This increases the timeout for plugins to 5 minutes.
    pluginTimeout: 5 * 60 * 1000,

    test: false,
    // Blank values count as unset: people blank a variable in .env to
    // "remove" it, and the in-memory fallback should kick in rather than
    // crash startup.
    mongoUri: getOption(env, "MONGO_URI", false)?.trim() || undefined,
    mongoTestUri: getOption(env, "MONGO_TEST_URI", false)?.trim() || undefined,
    authSkip: getBooleanOption(env, "AUTH_SKIP", false),
    rateLimitIpMax: positiveIntegerOption(env, "RATE_LIMIT_IP_MAX"),
    rateLimitReadMax: positiveIntegerOption(env, "RATE_LIMIT_READ_MAX"),
    rateLimitWriteMax: positiveIntegerOption(env, "RATE_LIMIT_WRITE_MAX"),
    rateLimitWindowMs: positiveIntegerOption(env, "RATE_LIMIT_WINDOW_MS"),
  };

  return options;
}

// Pass --options via CLI arguments in command to enable these options.
export const options: AppOptions = lazyOptions(() => loadOptions());
