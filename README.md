# template-api

A small Fastify + TypeScript service with MongoDB built in. Bun runs it and Biome keeps it tidy. With no configuration at all, dev and tests spin up a throwaway in-memory MongoDB, so `bun install && bun run dev` is genuinely all it takes to get going.

## What you need

Bun 1.4.2 or newer. Older versions break the MongoDB driver; 1.3.14 will not work. Docker is only worth installing if you want a database that survives restarts.

## Running it

```sh
bun install
bun run dev
```

That serves http://localhost:3000. The first run downloads an in-memory MongoDB binary, roughly 150 MB, once. After that it's cached and startup is quick. If you'd rather have persistent data:

```sh
docker compose up -d
cp .env.example .env
```

## Custom events

`POST /events` creates a custom event for the authenticated user. Example using
the local sample account:

```sh
curl -i http://localhost:3000/events \
  -H 'Authorization: Bearer alice-dev-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Doctor appointment",
    "eventType": "appointment",
    "isOptional": false,
    "schedule": {
      "kind": "timed",
      "startsAt": "2026-10-05T10:00:00+08:00",
      "endsAt": "2026-10-05T11:00:00+08:00"
    }
  }'
```

Success returns `201 Created` with the event, including its generated `id`,
calendar `uid`, revision `1`, and timestamps. Timed responses use UTC ISO strings;
the timetable remains fixed to `Asia/Hong_Kong`. All-day events instead use
`{ "kind": "all-day", "startsOn": "2026-10-05", "endsOn": "2026-10-06" }`,
where the end date is exclusive.

The server derives ownership from the token. Unexpected fields (including
`ownerId` and `timeZone`), invalid values, or an end not after the start return
`400`. Missing or unknown credentials return `401`; malformed authorization
headers return `400`. Rejected requests do not create an event.

Appointments default to email reminders 24 hours and 2 hours before; other
event types default to email disabled. Explicit `emailNotifications` settings
override these defaults. This endpoint only stores settings; it does not send
email. Updating, deleting, and recurrence are still pending.

### Reading events

All GET endpoints require the same bearer token:

| Request | Result |
| --- | --- |
| `GET /events` | The user's non-recurring events across all dates, paginated |
| `GET /events?from=2026-10-05&to=2026-10-12` | Non-recurring events overlapping that Hong Kong calendar week |
| `GET /events/:id` | One owned event, using the `id` returned by creation |

`from` and `to` must either both be supplied or both omitted. They are date-only
values interpreted at Hong Kong midnight. `to` is exclusive; the range must be
1–93 days. Events crossing a boundary are included, but an event ending exactly
at `from` or starting exactly at `to` is excluded. Recurring series and occurrence
expansion are not supported yet; list queries exclude documents with recurrence.

Lists return `{ "items": [...], "nextCursor": "..." }`. The default page size
is 50; set `limit` to an integer from 1 to 100. Pass `nextCursor` as `after` with
the same range filters to request the next page. A null cursor means no further
page. Results are ordered by ascending event ID, not scheduled time; the UI can
arrange them on its calendar. Pages are live reads, not a frozen snapshot.

```sh
curl 'http://localhost:3000/events?from=2026-10-05&to=2026-10-12&limit=50' \
  -H 'Authorization: Bearer alice-dev-token'
```

Invalid query values or malformed IDs return `400`. A missing event or an event
owned by another user returns the same `404`. Client-supplied `ownerId` and
`timeZone` query fields are rejected; ownership always comes from authentication.

See [the event model](docs/event-model.md) for field rules and planned features.
The API schema is available at `/documentation` and `/reference` when running.

## Environment

Everything here is optional. Copy `.env.example` to `.env` and set what you need.

| Variable | What it does |
| --- | --- |
| `MONGO_URI` | MongoDB URI for dev. Unset means in-memory. |
| `MONGO_TEST_URI` | Same thing, but for `bun test`. |
| `AUTH_SKIP` | Set to `true` to turn auth off locally. |

## Scripts

| Script | What it does |
| --- | --- |
| `bun run dev` | Dev server, watch mode, debug logs |
| `bun run start` | Same without watch, info logs |
| `bun run test` | Tests, with coverage |
| `bun run compile` | Type-check `src` and `test` with `tsc` |
| `bun run check` | Read-only formatting + lint check |
| `bun run lint` | Auto-fix lint issues |
| `bun run fmt` | Auto-format the repo |

## Auth

Users and their tokens live in `src/auth/users.ts`. There are two sample users, alice and bob, and their tokens act as passwords, so replace them before deploying anything real. Protected routes want a bearer header:

```sh
curl http://localhost:3000/auth-example
# 401 Missing Authorization Header

curl -H "Authorization: Bearer alice-dev-token" http://localhost:3000/auth-example
# alice
```

To protect your own routes, wrap them in a `fastify.withAuth` scope. Everything inside is protected, the auth error responses get documented for you, and `request.user` is typed non-null:

```typescript
const authExample: FastifyPluginAsync = async (
  fastify: FastifyTypebox,
): Promise<void> => {
  fastify.withAuth(async (fastify) => {
    fastify.get(
      "/",
      {
        schema: {
          summary: "Auth Example",
          tags: ["Auth"],
          security: [{ Auth: [] }],
          response: {
            200: Type.String({
              description: "The authenticated user's username.",
            }),
          },
        },
      },
      async (request) => request.user.username,
    );
  });
};
```

Setting `AUTH_SKIP=true` turns verification off completely. Scoped requests then come in as a fixed anonymous user (`{ username: "anonymous", name: null }`, plus an `X-Auth-Skip: true` response header), and stale tokens in your HTTP client stop causing mystery 401s.

## API docs

Swagger UI is at http://localhost:3000/documentation, Scalar at http://localhost:3000/reference.

## Where things live

```
src/
  app.ts                # Fastify app: options, plugins, routes
  options.ts            # Environment variable parsing
  plugins/
    auth.ts             # Bearer-token auth plugin + withAuth scope
    init-mongo.ts       # Collections and index bootstrap
    sensible.ts         # @fastify/sensible error helpers
  auth/
    users.ts            # Users and tokens
  routes/
    example/            # Public example route
    auth-example/       # Protected example route
test/
  routes/               # Route tests
  auth-schema.test.ts   # withAuth schema-merging contract tests
  init-mongo.test.ts    # MongoDB URI-defaulting tests
  mongo.test.ts         # Full-app boot + in-memory MongoDB wiring
  options.test.ts       # Env parsing tests
```

## Tests

`bun run test` runs everything. Route tests exercise each plugin on a bare Fastify instance; the Mongo test boots the whole app, plugins autoloaded and collections created, against the in-memory server unless `MONGO_TEST_URI` is set. No external services anywhere.

## Adding your own stuff

New routes go in a folder under `src/routes/`; the autoload picks them up, and an exported `autoPrefix` controls the URL prefix if you want one. New collections and their indexes go in `src/plugins/init-mongo.ts`, following the `example` pattern, and show up as `fastify.collections.<name>`.
