# USThing Timetable API

Backend for user-owned custom timetable events, built with Fastify, TypeScript,
Bun and MongoDB. It supports CRUD, daily/weekly recurrence, individual occurrence
exceptions, event colors, conflict checking, iCalendar (`.ics`) export and optional
email reminders.
There is no frontend.

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

The API runs at `http://localhost:3000`. MongoDB uses a persistent named volume
and a single-node replica set for transactions. This is not database redundancy.
Compose enables authentication and binds host ports to localhost. This is a local
technical-test deployment with two sample accounts:

| User | Bearer token |
| --- | --- |
| Alice | `alice-dev-token` |
| Bob | `bob-dev-token` |

These are public development credentials, not real student accounts. Each account
can access only its own events. OAuth and user registration are not implemented.
Startup seeds private MongoDB user profiles keyed by the same stable IDs, with
`alice@example.invalid` and `bob@example.invalid` as mock email addresses. Tokens
remain in the internal authentication table and are not stored in these profiles.
Restarts preserve existing profile addresses. No API accepts or returns recipient
email addresses, and ICS exports exclude them.

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
    "color": "#DC2626",
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
- Optional `color` accepts a six-digit RGB hex string such as `#2563EB`.
  POST defaults by category: class `#2563EB` (blue), appointment `#DC2626` (red),
  club `#7C3AED` (purple), study `#16A34A` (green), personal `#DB2777` (pink),
  other `#64748B` (slate). GET always returns the effective color. PATCH preserves
  an omitted color, even when changing category; supply `color` to change it.
  Occurrences inherit their series color unless individually overridden. Older
  events without a stored color use their category default without a migration.
- With `allowConflicts: false`, a proposed write must not overlap existing events
  or occurrences belonging to that user. `true` permits that write to overlap;
  existing events still participate in other conflict checks. Touching endpoints
  are allowed.
- New appointments default to email reminders `{enabled: true, minutesBefore:
  [1440, 120]}` (24 hours and 2 hours before); other event types default off.
  Explicit settings override these defaults. Custom timings accept 1–3 unique
  whole minutes from 0 to 10080. PATCH preserves omitted settings, even when the
  event type changes. Existing disabled events and archived preferences are not
  automatically re-enabled. Recipient addresses belong to private user profiles,
  never event requests or responses.
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

## Try email reminders locally

Delivery is off in the default stack. Enable the optional worker and Mailpit inbox:

```sh
docker compose --profile reminders up --build -d --wait
```

Open [Mailpit](http://localhost:8025). It captures SMTP messages locally; this
configuration does not deliver to real inboxes. Set `MAILPIT_PORT` if 8025 is busy.
The SMTP port is accessible only inside the Compose network.

Create an appointment through Swagger UI or `POST /events`, choosing a start two
minutes in the future and these settings:

```json
"emailNotifications": { "enabled": true, "minutesBefore": [1] }
```

Expect a message to the owner's mock address about one minute before the event.
Dates must be in the future for this test; the fixed example above is not a live
reminder test. Timings are best effort, not exact to the second.

```sh
docker compose logs -f reminders
docker compose stop reminders       # Pause delivery; preserve jobs
# Resume with the profile startup command above.
```

The separate worker uses [Agenda](https://github.com/agenda/agenda) to persist and
lock jobs in MongoDB, and [Nodemailer](https://nodemailer.com/smtp) to send SMTP.
It checks for scheduling work every five seconds, processing up to 50 changed or
due events per pass. Text and color edits preserve existing planning state;
schedule, recurrence and reminder changes mark an event for replanning. It schedules the next 24 hours of reminders and refreshes
unchanged events hourly. Recurrence and occurrence exceptions use the same
calendar rules as the API; all-day reminders count back from Hong Kong midnight.

The planner is shared across users, not one timer per user. Its 50-event batches
can create a backlog during bursts; adding delivery workers does not increase the
singleton planner's capacity. This deployment has not been load-tested for 10,000
users. Higher volume requires planner throughput improvements and measurements
of backlog, reminder lateness and SMTP-provider limits.

Before sending, the worker rechecks the current event, preferences and private
user email. Deleted, cancelled, disabled or rescheduled reminders are skipped.
Temporary SMTP failures get three retries after 5, 10 and 20 seconds; permanent
rejections are not retried. A ten-minute grace period permits brief outages,
but advance reminders are never sent after the event starts. Zero-minute
reminders may arrive within that grace period. Reminders due before event
creation are not backfilled. Expired reminders are skipped, and job records
expire seven days after their due time.

Unique job keys prevent duplicate scheduling. SMTP cannot guarantee exactly-once
delivery: a crash after the mail server accepts a message but before its outcome
is saved can cause a duplicate. A cancellation after the final check cannot recall
an email already being sent. Completed or skipped jobs are not replayed.

To use a real provider later, configure the worker's `SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURE`, `SMTP_FROM` and optional paired `SMTP_USER`/`SMTP_PASSWORD`, then
replace mock profile addresses with verified account emails. Provider credentials
belong in deployment secrets. The supplied Compose profile intentionally fixes
SMTP to Mailpit. Standalone workers require `EMAIL_DELIVERY_ENABLED=true` and
`MONGO_URI`; run them with `bun run worker` after starting the API once to seed
profiles. Production sender verification, monitoring and provider setup remain
separate deployment work.

## Development and checks

Use Bun 1.4.2 or newer:

```sh
bun install --frozen-lockfile
bun run dev
```

Without a database URI in non-production mode, the app starts a temporary real
MongoDB replica set using `mongodb-memory-server`. Its first use may download a MongoDB
binary; this database is disposable. For persistent local development, start
`docker compose up -d mongodb` and set
`MONGO_URI=mongodb://localhost:27018/template-api?replicaSet=rs0&directConnection=true` in `.env`. See `.env.example`.
Do not start both the local API and the container API on the same host port.

```sh
bun run compile  # Type-check source and tests
bun run check    # Formatting and lint checks
bun run test     # Unit and HTTP integration tests, with coverage
```

The test suite includes concurrent writes and shared rate budgets across independent
API instances, more than 5000 live rate counters, configuration errors and log redaction. Integration tests use Fastify
injection and temporary real MongoDB instances to exercise persistence, ownership,
conflicts, revisions, recurrence and failure cases. Reminder tests use a local SMTP
server to check delivery, retries, restarts, competing workers and changed events.
This is not a production load
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
methods, including occurrence restoration. Counters are atomic MongoDB records,
survive API restarts and expire through TTL cleanup. Active counters are not evicted;
database failures return `503` rather than bypassing limits. All replicas must use
the same limit configuration. `AUTH_SKIP` rejects malformed boolean values at
startup; `AUTH` is rejected as an unsupported alias. Logs redact authorization and
cookie headers, including at debug level.

## Architecture and scope

Read [architecture](docs/architecture.md) for the folder structure, request flow
and design tradeoffs.

API processes sharing one database coordinate event writes through MongoDB
transactions and a per-owner coordination document. A standalone MongoDB server
is rejected at startup; use a replica set or supported sharded deployment. Compose
initializes a single-node replica set while preserving its existing data volume.
The supplied Compose file exposes one API instance; multiple instances require
appropriate ports or a load balancer. Before public deployment, replace sample
authentication, configure HTTPS and trusted proxies, add database availability
and backups, and verify capacity under realistic load.

GitHub Actions runs `verify` (frozen install, coverage tests, source/test type
checks and Biome) and `docker` (image build) on pushes and pull requests. Make
both checks required in branch protection before allowing merges; the workflow
alone does not prevent an administrator from bypassing checks. No deployment or
image publication is configured.

ICS import, production email-provider setup, infinite recurrence and “this and
following” series splitting are outside the implemented scope.
