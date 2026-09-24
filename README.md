# template-api

A small Fastify + TypeScript service with MongoDB built in. Bun runs it and Biome keeps it tidy. With no configuration at all, dev and tests spin up a throwaway in-memory MongoDB, so `bun install && bun run dev` is genuinely all it takes to get going.

## What you need

Bun 1.4.2 or newer. Older versions break the MongoDB driver; 1.3.14 will not work. Docker Desktop (or Docker Engine with Compose) can run the entire service and a persistent database.

## Running with Docker

```sh
docker compose up --build -d --wait
curl http://localhost:3000/health
```

This builds the API image and starts it after MongoDB is healthy. The API is at
http://localhost:3000 and documentation at http://localhost:3000/documentation.
`/health` returns `200 { "status": "ok" }` when MongoDB responds and `503` when
unavailable. The containers use their own network: the API connects to
`mongodb://mongodb:27017/template-api`, not to localhost.

The Dockerfile uses pinned Bun 1.4.2, frozen production dependencies, and a
non-root runtime user. Bun executes TypeScript directly. The build context
excludes local dependencies, caches, tests and `.env`; Compose passes only the
explicit runtime settings. MongoDB is pinned to 8.3.4 and keeps data in the
`mongo_data` named volume. The API waits for database health and has its own
readiness health check.

```sh
docker compose ps
docker compose logs -f api
docker compose down
```

`down` removes containers but keeps database data. Running `up --build -d --wait`
again reuses that volume. **`docker compose down -v` deletes the volume and all
its events.** Don't use `-v` when testing persistence.

Host ports are loopback-only for this local technical-test setup. Override
`API_PORT` (default 3000) or `MONGO_HOST_PORT` (default 27018) if occupied. Inside
the containers, ports remain 3000 and 27017. Compose explicitly disables
`AUTH_SKIP` and uses the two documented sample accounts. This is a reproducible
local deployment, not a public deployment with real credentials.

Keep one API replica: conflict locks and rate counters are process-local. Docker
packages the service but does not turn those mechanisms into distributed locks.
On Windows, start Docker Desktop and enable the distro under Settings →
Resources → WSL Integration before running Docker commands from WSL.

See [container verification](docs/container-verification.md) for verification
status and the persistence check.

## Running locally without the API container

```sh
bun install
bun run dev
```

That serves http://localhost:3000. The first run downloads an in-memory MongoDB binary, roughly 150 MB, once. After that it's cached and startup is quick. If you'd rather have persistent data:

```sh
docker compose up -d mongodb
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
    "allowConflicts": false,
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
email. Basic event CRUD is implemented; recurrence and reminder delivery are
still pending.

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

### Updating and deleting events

`POST /events`, `GET /events/:id`, and successful PATCH responses include an
`ETag` header containing the quoted revision, such as `"1"`. PATCH and DELETE
require that value in `If-Match`. A list item also includes its numeric revision,
which can be quoted to form the same header. This prevents stale clients from
overwriting or deleting newer edits.

```sh
# Replace EVENT_ID with the ID returned by creation.
curl -i -X PATCH 'http://localhost:3000/events/EVENT_ID' \
  -H 'Authorization: Bearer alice-dev-token' \
  -H 'If-Match: "1"' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Updated appointment","allowConflicts":true}'
```

PATCH returns `200` with the updated event and next ETag. Only supplied fields
change. At least one editable field is required. A supplied `schedule` or
`emailNotifications` object replaces that whole object and must have a valid
shape. An omitted notification field preserves existing reminders, even when
`eventType` changes. Explicit `{ "enabled": true }` resets timings to the
24-hour and 2-hour defaults. Use an empty string to clear description or location
text; null is not accepted. Ownership, IDs, revision, timestamps and `timeZone`
cannot be supplied in the body.

```sh
# Use the latest ETag: the example PATCH changes revision 1 to revision 2.
curl -i -X DELETE 'http://localhost:3000/events/EVENT_ID' \
  -H 'Authorization: Bearer alice-dev-token' \
  -H 'If-Match: "2"'
```

DELETE returns `204` with no body. Deletion is permanent. Both mutations return:

| Status | Meaning |
| --- | --- |
| `400` | Invalid input, ID or revision header; business validation failed |
| `401` | Missing or unknown bearer token |
| `404` | No event belongs to this user at that ID |
| `409` | The proposed event overlaps another event and conflicts are disabled |
| `412` | Revision is stale; fetch the latest event before retrying |
| `428` | Required `If-Match` header is missing |

The API accepts one quoted positive revision, not wildcard, weak or multiple
ETags. Each successful PATCH increments the revision, even if the supplied
values equal the current values. Repeating a completed deletion returns `404`.

See [the event model](docs/event-model.md) for field rules and planned features.
The API schema is available at `/documentation` and `/reference` when running.

## Rate limits

The API uses [@fastify/rate-limit](https://github.com/fastify/fastify-rate-limit).
Defaults are 120 requests per IP, 120 reads per authenticated user, and 30 writes
per authenticated user in a 60-second fixed window. Both IP and user limits
apply. POST, PATCH and DELETE share the write budget; GET and HEAD share reads.
Excess requests receive `429 Too Many Requests` and a `Retry-After` header in
seconds. Wait for that delay before retrying. Rejected writes do not reach the
event service. Invalid requests also consume the budgets they reach.

`X-RateLimit-Scope` identifies the displayed budget (`ip`, `user-read` or
`user-write`); `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`
report its limit, remaining requests and seconds until reset. Browser clients
can read these headers and `Retry-After` through CORS.

Configure positive integers using `RATE_LIMIT_IP_MAX`, `RATE_LIMIT_READ_MAX`,
`RATE_LIMIT_WRITE_MAX` and `RATE_LIMIT_WINDOW_MS` (defaults 120, 120, 30, 60000).
Blank values use defaults; invalid values fail startup. Counters live in this
API process, reset on restart, and evict old keys at a bounded capacity. Use a
shared store such as Redis before running multiple replicas. Tune the IP limit
for users sharing a campus network. Do not blindly enable `trustProxy`: trust
only your deployment's known proxies, otherwise IP headers could be forged.

## Conflict preference

`allowConflicts` replaces the former `isOptional` field in requests, responses
and stored event types. It is required on creation, and optional in PATCH.
It expresses permission to overlap other events, not optional attendance.
The backend rejects overlapping POST and PATCH requests with `409` when the
resulting event has `allowConflicts: false`. Explicitly setting it to true allows
the event being saved to overlap; it does not hide existing events from conflict
checks. Checks include timed and all-day events belonging to the same user,
using Hong Kong midnight for all-day boundaries. Touching endpoints do not
conflict, and an update excludes the event itself from its check.

Each user's writes are serialized inside the current API process so simultaneous
requests cannot both pass a check before saving. Other users can write
independently. This protection assumes one API process and all writes using the
service layer. Multiple replicas or direct database writers require a
database-coordinated strategy before deployment; revision checks alone do not
protect overlaps across different event documents.

The old request field is rejected. Existing
development records using the old field need recreation or an explicit migration
with a chosen conflict preference; no database migration is performed here.

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
