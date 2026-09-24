# Backend status review — 24 September 2026

The project now implements custom-event CRUD, multi-user ownership, validation,
reminder settings, paginated calendar reads, revision-protected mutations,
request rate limits, ICS export, daily/weekly recurrence, individual exceptions,
and backend overlap rejection across complete finite series.
The API and MongoDB are containerized and verified together. Task 2 remains
unstarted. Email delivery and template cleanup remain outstanding.

## How a request works

1. Fastify receives the HTTP request and checks the IP allowance.
2. The auth scope resolves the bearer token to a stable user ID.
3. Authenticated reads and writes consume separate per-user allowances.
4. TypeBox validates the request shape without silently removing fields.
5. The service checks business rules and derives ownership from authentication.
6. Writes for one owner are serialized within this API process. Creates and
   updates with allowConflicts=false check existing events before saving.
7. MongoDB persists the event. Updates and deletions also match its revision.
8. The response mapper exposes public fields and converts timed dates to ISO
   strings. The frontend displays those instants in Hong Kong time.

HTTP is the frontend-facing interface; the MongoDB driver handles database
communication. TypeScript types guide our code, while TypeBox and business
validation enforce actual request values. Types do not install database validators.

## Source files

| File | What it does and why it exists |
| --- | --- |
| [src/app.ts](../src/app.ts) | Builds Fastify, registers CORS, rate limits, OpenAPI documentation, plugins and routes. Exposes ETag and rate-limit headers to browser clients. |
| [src/options.ts](../src/options.ts) | Loads database/auth configuration and positive-integer rate settings. Invalid configured limits fail startup. |
| [src/auth/users.ts](../src/auth/users.ts) | Defines the two sample identities and bearer tokens. Stable UUIDs identify owners independently of usernames. These users are stored in code, not MongoDB. |
| [src/plugins/auth.ts](../src/plugins/auth.ts) | Template authentication extended with stable IDs. Hashes tokens for constant-time digest comparison, populates request.user and protects withAuth scopes. The public identity excludes the token. Much of the file implements TypeScript typing and HTTP error/schema integration. |
| [src/plugins/init-mongo.ts](../src/plugins/init-mongo.ts) | Connects to configured or temporary MongoDB, registers typed events collection, and creates UID, pagination and range indexes. The inherited example collection remains. |
| [src/plugins/sensible.ts](../src/plugins/sensible.ts) | Registers standard HTTP error helpers and their shared schema. |
| [src/rate-limits.ts](../src/rate-limits.ts) | Applies IP checks before auth and read/write checks after auth, returning 429 and retry headers when exhausted. |
| [src/rate-limit-store.ts](../src/rate-limit-store.ts) | Bounded, fixed-window in-memory counters. Independent snapshots prevent simultaneous requests from changing each other's observed counts. |
| [src/events/calendar-read.ts](../src/events/calendar-read.ts) | Bounded live pagination of normal events and effective recurring occurrences. |
| [src/events/series.ts](../src/events/series.ts) | Shared schedule conversion, finite expansion, exception application and aggregate budgets. |
| [src/events/exception-schema.ts](../src/events/exception-schema.ts), [src/events/exception-service.ts](../src/events/exception-service.ts), [src/events/exception-routes.ts](../src/events/exception-routes.ts) | Strict authenticated occurrence edits, cancellations and restoration using parent revisions and atomic embedded exceptions. |
| [src/events/occurrences.ts](../src/events/occurrences.ts) | Runtime-validated full-series and ranged generation with a 367-occurrence series cap. |
| [src/events/recurrence-schema.ts](../src/events/recurrence-schema.ts), [src/events/recurrence.ts](../src/events/recurrence.ts) | Optional daily/weekly recurrence contract and HK end-date resolution, persisted once when a rule is saved. |
| [src/events/ics.ts](../src/events/ics.ts) | Bounded, owned ICS export with UTC instants, date-only all-day events, stable UIDs and safe text serialization via ical.js. |
| [src/events/schemas.ts](../src/events/schemas.ts) | Runtime create-input contract: fields, lengths, event kinds, timed/all-day schedules, allowConflicts and email settings. Rejects extra fields, including client timezone and ownership. Also derives TypeScript input types. |
| [src/events/query-schemas.ts](../src/events/query-schemas.ts) | Validates event IDs, date-range query values and cursor pagination parameters. |
| [src/events/mutation-schemas.ts](../src/events/mutation-schemas.ts) | Derives a nonempty partial PATCH body and validates the supported If-Match header shape. Nested objects remain whole replacements. |
| [src/events/validation.ts](../src/events/validation.ts) | Rejects equal or reversed intervals after structural validation. Past events are allowed. |
| [src/events/defaults.ts](../src/events/defaults.ts) | Resolves email settings. Appointments default to reminders 1440 and 120 minutes before; other types default to off. Explicit choices override defaults. |
| [src/events/model.ts](../src/events/model.ts) | Describes stored documents: ObjectId, owner, details, resolved settings, calendar UID, revision and timestamps. Timed values use Date; all-day values use date strings. Recurrence ends are resolved and exceptions are embedded. |
| [src/events/service.ts](../src/events/service.ts) | Creates and retrieves owned events. Implements bounded, cursor-paginated listing and optional Hong Kong range filtering. Calls conflict checking inside the owner's write lock before inserting. |
| [src/events/mutations.ts](../src/events/mutations.ts) | Merges PATCH input with stored state, validates the whole candidate, preserves omitted settings and checks overlaps. Updates/deletes use atomic owner-and-revision predicates. |
| [src/events/conflicts.ts](../src/events/conflicts.ts) | Checks all effective finite occurrences, including self-overlap, mixed schedules and exceptions. Bounded scans fail closed; the current parent is excluded when editing. |
| [src/events/write-lock.ts](../src/events/write-lock.ts) | Serializes check-and-write operations per owner in one process. Releases on success or failure and removes idle entries; different owners operate independently. |
| [src/events/response.ts](../src/events/response.ts) | Defines public response schemas and explicitly maps storage into JSON, omitting internal ownership and renaming _id to id. |
| [src/routes/health/index.ts](../src/routes/health/index.ts) | Returns readiness based on a bounded MongoDB ping, with generic failure responses. |
| [src/routes/events/index.ts](../src/routes/events/index.ts) | Connects HTTP methods to auth, strict validation, services and documented status codes. Routes carry transport concerns; services carry event behavior. |
| [src/routes/auth-example/index.ts](../src/routes/auth-example/index.ts) | Inherited protected demonstration route. Useful while learning; remove or justify in final submission cleanup. |
| [src/routes/example/index.ts](../src/routes/example/index.ts) | Inherited public demonstration routes. Not an event feature; remove with related template scaffolding before final polish. |

## Tests

These are automated checks, not feature code. HTTP integration tests use Fastify
inject and temporary real MongoDB servers; they do not edit a configured persistent
user database. CRUD tests explicitly raise rate budgets so validation cases do not
interfere with each other. Dedicated rate tests use small budgets.

| Test file | Behavior verified |
| --- | --- |
| [test/routes/events-recurrence.test.ts](../test/routes/events-recurrence.test.ts) | End-to-end recurrence, full-series conflicts, exceptions, pagination, concurrency, security limits and ICS equivalence. |
| [test/events/occurrences.test.ts](../test/events/occurrences.test.ts) | Range boundaries, invalid inputs, bounded work, stable original starts and 600 comparisons against exhaustive expansion. |
| [test/events/recurrence.test.ts](../test/events/recurrence.test.ts) | Optional rules on either schedule, strict values, inclusive date bounds, 12-month defaults, leap days and HK date conversion. |
| [test/routes/events-export.test.ts](../test/routes/events-export.test.ts) | Download format, ownership, text escaping, HK boundaries, revision metadata, output limits and shared read limits. |
| [test/events/schemas.test.ts](../test/events/schemas.test.ts) | Valid inputs, bad dates, bounds, protected fields, email rules and rejection of the old isOptional field. |
| [test/events/defaults.test.ts](../test/events/defaults.test.ts) | Default reminders, explicit overrides and input/array independence. |
| [test/events/validation.test.ts](../test/events/validation.test.ts) | Interval ordering, equivalent offsets, all-day boundaries and unchanged input. |
| [test/events/storage.test.ts](../test/events/storage.test.ts) | MongoDB date round-trips and UID uniqueness per owner. |
| [test/routes/events.test.ts](../test/routes/events.test.ts) | POST authentication, strict validation, server-derived ownership, defaults and public responses. |
| [test/routes/events-get.test.ts](../test/routes/events-get.test.ts) | Read isolation, pagination, all-date listing, HK range boundaries and invalid queries. |
| [test/routes/events-mutations.test.ts](../test/routes/events-mutations.test.ts) | Partial edits, settings replacement, revision handling, deletion, protected fields and competing writes. |
| [test/routes/events-conflicts.test.ts](../test/routes/events-conflicts.test.ts) | Backend overlap rejection, mixed schedules, touching endpoints, owner isolation, explicit overrides and concurrent checks/saves. |
| [test/routes/events-rate-limits.test.ts](../test/routes/events-rate-limits.test.ts) | Shared POST/PATCH/DELETE budget and proof that rejected requests do not mutate MongoDB. |
| [test/rate-limits.test.ts](../test/rate-limits.test.ts) | IP/user separation, endpoint sharing, forwarded-IP spoofing, IPv6 subnet grouping, bursts and expiry. |
| [test/options.test.ts](../test/options.test.ts) | Configuration parsing and rejected invalid rate settings. |
| [test/mongo.test.ts](../test/mongo.test.ts) | MongoDB startup, readiness success/failure and example-collection operations. |
| [test/init-mongo.test.ts](../test/init-mongo.test.ts) | URI/database defaults and connection-string handling. |
| [test/routes/auth-example.test.ts](../test/routes/auth-example.test.ts) | Stable identities, auth success/failure, safe public identity and development bypass. |
| [test/routes/auth-schema.test.ts](../test/routes/auth-schema.test.ts) | Auth response documentation and preservation of standard validation errors. |
| [test/routes/example.test.ts](../test/routes/example.test.ts) | Template route and HTTP error behavior. |

## Configuration and documentation

| File | Purpose and status |
| --- | --- |
| [package.json](../package.json) | Runtime/development dependencies and commands. Bun runs code/tests, TypeScript checks types, Biome checks style. The package name is still template-api. |
| [bun.lock](../bun.lock) | Locks resolved dependency versions for reproducible installs. |
| [tsconfig.json](../tsconfig.json), [test/tsconfig.json](../test/tsconfig.json) | Strict source/test type checking without emitted build files. |
| [biome.json](../biome.json) | Consistent formatting, imports and lint rules. |
| [.gitignore](../.gitignore) | Excludes credentials, dependency folders, caches and coverage. |
| [.env.example](../.env.example) | Documents database/auth options and default request limits without real secrets. |
| [Dockerfile](../Dockerfile), [.dockerignore](../.dockerignore) | Builds a non-root Bun runtime with frozen production dependencies and excludes credentials/caches from the build context. |
| [docs/container-verification.md](container-verification.md) | Records actual Docker startup, CRUD, ownership and volume-persistence verification with repeatable manual steps. |
| [compose.yaml](../compose.yaml) | Runs one API and MongoDB with health checks, local ports and a persistent database volume. |
| [README.md](../README.md) | Startup commands, endpoint examples, errors, concurrency/rate behavior and current limitations. |
| [docs/recurrence.md](recurrence.md) | Recurrence API examples, exception semantics, resource limits and export behavior. |
| [docs/event-model.md](event-model.md) | Explains data representations, domain rules and ICS export, recurrence and planned email behavior. Planned sections are not implemented features. |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Template development conventions and required checks. |
| [docs/status-review.md](status-review.md) | This dated review; update after major milestones rather than treating it as a live feature list. |

## Review conclusions and remaining work

- CRUD and owner isolation are implemented. An unknown/foreign event returns the
  same 404. IDs, tokens, ownership and revision have distinct roles.
- allowConflicts=false rejects overlapping creates/updates with 409. The flag
  applies to the event being saved; true explicitly permits that operation even
  if an existing event has false. Existing events always participate in checks.
- Same-owner concurrent API writes are protected in one process. This is not
  distributed conflict protection. Direct database writes bypass application
  checks. Multi-instance deployment needs database-coordinated writes and shared
  rate counters, plus suitable integration/load testing.
- Sample credentials and AUTH_SKIP are for local testing. Keep bypass disabled
  and replace sample credentials before any real deployment. No user registration,
  real account store or verified notification email configuration exists yet.
- The field rename is a breaking contract change. Old records need recreation
  or an explicit migration with a chosen allowConflicts value. No live database
  migration was run, and TypeScript types do not enforce stored document shape.
- ICS export, conflict rejection and rate limiting are implemented extras.
  Recurrence, full-series conflicts, calendar reads, whole-series mutations,
  individual cancellation/edit/restore and recurring ICS export are implemented.
  Email delivery is not implemented; ICS import is out of scope.
  MCP is an optional alternative, not required alongside every other extra.
- API and MongoDB containerization is complete. Actual Docker build, readiness,
  CRUD and persistence after container recreation are verified. This is a local
  test deployment; process-local locks and counters still require one API instance.
- Remove leftover template example routes/collection/tests and update package
  branding before submission. Finish documentation against actual implemented
  scope; do not advertise email delivery as complete.
- Task 2's PR review remains separate and unstarted; its patch must be supplied.

Next implementation order: finish template cleanup and documentation, complete
Task 2, and verify submission instructions. Email delivery can
remain future work; ICS export fulfills a suggested calendar extra. Deadline from the
brief: 26 September 2026, 23:59 HKT.

## Verification and commit

At this review, all 371 tests pass, along with TypeScript and Biome checks.
The production Docker image was built and smoke-tested for recurrence creation,
range reads, cancellation, restart persistence, owner isolation, ICS export,
restoration and whole-series deletion. Tests include concurrency behavior but are not a production load test.
The local sandbox has a WSL mount startup problem; checks ran outside it with
approval. No commit was made by the assistant for this milestone.

Suggested commit message:

```text
feat: support recurring calendars and occurrence exceptions
```
