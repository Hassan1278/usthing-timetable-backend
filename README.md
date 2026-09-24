# USThing Timetable API

Backend for user-owned custom timetable events, built with Fastify, TypeScript,
Bun and MongoDB. It supports CRUD, daily/weekly recurrence, individual occurrence
exceptions, conflict checking and iCalendar (`.ics`) export. There is no frontend.

## Quick start

Install Docker Engine with Compose, or Docker Desktop with WSL integration.
From the repository root:

```sh
docker compose up --build -d --wait
curl --fail http://localhost:3000/health
```

Expected response: `{"status":"ok"}`. Open [Swagger UI](http://localhost:3000/documentation)
for interactive API documentation or [Scalar](http://localhost:3000/reference)
for an alternative view.

The API runs at `http://localhost:3000`. MongoDB uses a persistent named volume.
Compose enables authentication and binds host ports to localhost. This is a local
technical-test deployment with two sample accounts:

| User | Bearer token |
| --- | --- |
| Alice | `alice-dev-token` |
| Bob | `bob-dev-token` |

These are public development credentials, not real student accounts. Each account
can access only its own events. OAuth and user registration are not implemented.

```sh
docker compose ps             # Service health
docker compose logs -f api   # Application logs
docker compose down          # Stop; preserve saved events
```

Running the startup command again reuses the database. **`docker compose down -v`
deletes the database volume.** If ports are occupied, prefix Compose commands with
`API_PORT=3001 MONGO_HOST_PORT=27019` and use the corresponding API port.

## Try the API

Create an event as Alice:

```sh
curl -i http://localhost:3000/events \
  -H 'Authorization: Bearer alice-dev-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Study session",
    "eventType": "appointment",
    "allowConflicts": false,
    "schedule": {
      "kind": "timed",
      "startsAt": "2026-10-05T14:00:00+08:00",
      "endsAt": "2026-10-05T15:00:00+08:00"
    }
  }'
```

Expect `201`, a generated `id`, revision `1` and `ETag: "1"`. Repeating the same
request returns `409` because it overlaps the event just created. The server
assigns ownership from authentication; clients cannot supply `ownerId`.

Read the calendar week, including recurring occurrences:

```sh
curl --fail 'http://localhost:3000/events?from=2026-10-05&to=2026-10-12' \
  -H 'Authorization: Bearer alice-dev-token'
```

Copy the returned event ID into this variable, then edit it:

```sh
EVENT_ID='paste-event-id-here'
curl -i -X PATCH "http://localhost:3000/events/$EVENT_ID" \
  -H 'Authorization: Bearer alice-dev-token' \
  -H 'Content-Type: application/json' \
  -H 'If-Match: "1"' \
  -d '{"title":"Updated study session"}'
```

Expect `200` and revision `2`. `If-Match` must contain the latest quoted revision;
a stale value returns `412`. PATCH changes supplied fields only. Nested objects,
such as `schedule`, are whole replacements, so supply their complete shape.

Export Alice's calendar, then delete the example event:

```sh
curl --fail http://localhost:3000/events/export.ics \
  -H 'Authorization: Bearer alice-dev-token' \
  -o usthing-events.ics

curl -i -X DELETE "http://localhost:3000/events/$EVENT_ID" \
  -H 'Authorization: Bearer alice-dev-token' \
  -H 'If-Match: "2"'
```

Deletion returns `204`. Export is a downloadable snapshot, not a subscription.

## API contract

All event routes require a bearer token. Missing or unknown credentials return
`401`; malformed authorization headers return `400`. Foreign and missing event
IDs both return `404`, avoiding disclosure of another user's events.

| Method and path | Purpose |
| --- | --- |
| `POST /events` | Create an event or recurring series |
| `GET /events` | Paginated non-recurring events across all dates |
| `GET /events?from=...&to=...` | Paginated events and occurrences overlapping a date range |
| `GET /events/:id` | Read one event or series parent |
| `PATCH /events/:id` | Edit an event or whole series; requires `If-Match` |
| `DELETE /events/:id` | Delete an event or whole series; requires `If-Match` |
| `PATCH /events/:id/occurrences?originalStart=...` | Override one occurrence; requires `If-Match` |
| `DELETE /events/:id/occurrences?originalStart=...` | Cancel one occurrence; requires `If-Match` |
| `POST /events/:id/occurrences/restore?originalStart=...` | Restore one occurrence; requires `If-Match` |
| `GET /events/export.ics` | Export events and series; optional `from`/`to` |
| `GET /health` | Public database readiness: `200` or `503` |

Important rules:

- The timetable uses **Asia/Hong_Kong**. Client `timeZone` fields are rejected.
  Timed inputs carry offsets; responses use UTC ISO timestamps. All-day schedules
  use `startsOn`/`endsOn` dates, with an exclusive end.
- Range queries require both dates and cover 1–93 days, with an exclusive `to`.
  This viewing limit does not limit conflict checking to 93 days.
- Lists return `{items, nextCursor}`. `limit` defaults to 50, maximum 100; pass
  `nextCursor` as `after` with the same filters. Results use stable identity order,
  not chronological order. Pagination is a live view, not a snapshot.
- Optional `recurrence` accepts `daily` or `weekly`. Its inclusive `endsOn`
  defaults to 12 calendar months after the first start and cannot exceed that.
  Occurrences are calculated from a stored parent and its exceptions.
- With `allowConflicts: false`, a proposed write must not overlap existing events
  or occurrences belonging to that user. `true` permits that write to overlap;
  existing events still participate in other conflict checks. Touching endpoints
  are allowed.
- Email delivery is disabled. Omission defaults to `{enabled: false}`;
  `enabled: true` returns `400` on creation and all edits. Startup disables legacy
  enabled settings, archives preferences internally and increments affected revisions.
- ICS includes recurrence rules, cancellations and overrides. Date filters select
  whole series, not clipped rules. Export and recurrence work are bounded;
  oversized exports return `413` instead of silently truncating results.

| Status | Meaning |
| --- | --- |
| `400` | Invalid input or business rule |
| `401` | Missing or unknown credentials |
| `404` | Missing event, occurrence or ownership |
| `409` | Disallowed overlap |
| `412` | Stale revision: read the event again |
| `428` | Missing required `If-Match` |
| `429` | Rate limit: wait for `Retry-After` |

The running OpenAPI documentation describes endpoint-specific responses.

## Development and checks

Use Bun 1.4.2 or newer:

```sh
bun install --frozen-lockfile
bun run dev
```

Without a database URI in non-production mode, the app starts a temporary real
MongoDB server using `mongodb-memory-server`. Its first use may download a MongoDB
binary; this database is disposable. For persistent local development, start
`docker compose up -d mongodb` and set
`MONGO_URI=mongodb://localhost:27018/template-api` in `.env`. See `.env.example`.
Do not start both the local API and the container API on the same host port.

```sh
bun run compile  # Type-check source and tests
bun run check    # Formatting and lint checks
bun run test     # Unit and HTTP integration tests, with coverage
```

The latest verified suite has 370 passing tests. Integration tests use Fastify
injection and temporary real MongoDB instances to exercise persistence, ownership,
conflicts, revisions, recurrence and failure cases. This is not a production load
test. The Docker build installs production dependencies but does not run these checks.

| Configuration | Default / purpose |
| --- | --- |
| `MONGO_URI` | Non-test database URI; temporary database in development when unset |
| `MONGO_TEST_URI` | Test database override; use only a disposable database |
| `AUTH_SKIP` | Local development bypass; leave disabled for normal use |
| `RATE_LIMIT_IP_MAX` | 120 requests per IP per window |
| `RATE_LIMIT_READ_MAX` | 120 reads per user per window |
| `RATE_LIMIT_WRITE_MAX` | 30 writes per user per window |
| `RATE_LIMIT_WINDOW_MS` | 60000 milliseconds |

Compose explicitly supplies its internal MongoDB URI and disables auth bypass.
The legacy database name `template-api` is retained to preserve existing data.
Rate settings must be positive integers. IP checks precede authentication; reads
and writes then consume separate user budgets. Writes share one budget across
methods, including occurrence restoration. Counters reset on API restart.

## Architecture and scope

Read [architecture](docs/architecture.md) for the folder structure, request flow
and design tradeoffs.

Run **one API process**: write locks and rate counters are process-local. Multiple
replicas require shared counters and database-coordinated conflict protection.
Before public deployment, replace sample authentication, configure HTTPS and
trusted proxies, and verify capacity under realistic load.

ICS import, email delivery, infinite recurrence and “this and following” series
splitting are outside the implemented scope. MCP is not implemented; recurrence
and ICS export provide the additional features for this technical test.
