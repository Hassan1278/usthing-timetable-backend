# Architecture

The service is a single Fastify application backed by MongoDB. It manages custom
events for authenticated users; a frontend can render the JSON responses as a
calendar. Keeping one deployable API and one database makes the test easy to run
and keeps calendar rules in one place.

## Structure and responsibilities

```text
src/
  app.ts                 Application assembly, plugins and route loading
  options.ts             Environment configuration
  auth/                  Sample identities and private user-profile storage
  plugins/               Authentication, MongoDB setup and HTTP error helpers
  rate-limits.ts         Request limits before and after authentication
  rate-limit-store.ts    Bounded in-process counters
  routes/
    events/              Main HTTP endpoint registration
    health/              Database readiness endpoint
  events/
    schemas/             Runtime request contracts and derived TypeScript types
    domain/              Stored document types, defaults and business validation
    services/            Persistence, conflicts, mutations and per-owner locking
    recurrence/          Recurrence bounds, expansion and exception application
    http/                Public responses, occurrence routes and ICS serialization
test/
  events/                Schema, domain, storage and recurrence checks
  routes/                HTTP behavior and authorization checks
```

Files are grouped by the event feature, then by responsibility. HTTP handlers
translate requests and errors; services enforce operations; recurrence helpers
calculate schedules. This lets one rule serve creation, editing and occurrence
changes without copying it into several routes. Small functions and shared
schemas provide reuse without a generic repository or class hierarchy.

Only `src/routes` is autoloaded. Helpers in `events/http` are explicitly imported,
so adding a helper file does not accidentally register an endpoint.

## How a write reaches MongoDB

1. Fastify applies the IP limit and authenticates the bearer token. Authentication
   resolves a stable user ID; the token itself is not returned in public responses.
2. The authenticated user consumes a write allowance. TypeBox schemas validate
   actual request values and reject unknown fields, including ownership and timezone.
3. The service applies defaults or merges an edit with the stored event. Business
   validation checks the complete result, including schedule ordering and reminder preferences.
4. A per-owner lock serializes conflict checking and saving. Full finite series
   are expanded with their exceptions before comparing intervals.
5. MongoDB stores the document. Updates/deletes match both ownership and revision;
   stale mutations fail instead of overwriting a more recent change.
6. An explicit response mapper returns public fields, converts dates and exposes
   the revision through an ETag. It excludes internal ownership and archived settings.

Reads also use the authenticated owner in database queries. A foreign event and
an unknown ID return the same 404. Authentication identifies the caller;
authorization restricts the documents that caller may access.

## Three representations of an event

**Request schemas** describe what clients may submit. TypeBox supplies runtime
validation and derived TypeScript types, reducing drift between the two.
TypeScript alone cannot validate JSON arriving over HTTP.

**EventDocument** describes storage: MongoDB ObjectId, owner ID, dates, recurrence,
embedded exceptions, revision and timestamps. It is a TypeScript contract, not a
MongoDB collection validator. The application validates writes; direct database
writes can bypass those rules.

**Response schemas and mapping** define the public API. They expose `id` instead
of `_id` and serialize timed dates to strings. Separating them from storage avoids
leaking internal fields when the database model grows.

MongoDB fits the parent-plus-exceptions document model: an individual exception
and its parent revision can change atomically in one document. Owner-prefixed
indexes support access patterns; a unique owner/UID index protects calendar IDs.
The native driver keeps database operations explicit without another model layer.

## Calendar decisions

The timetable is fixed to Hong Kong. Timed events store absolute instants as
MongoDB dates; all-day events store calendar dates. End boundaries are exclusive,
so adjacent events do not conflict. Response timestamps use UTC; clients display
them in Hong Kong time.

A recurring event stores one daily/weekly rule, a finite end and embedded
exceptions, rather than a document per occurrence. Generation is bounded to at
most 12 calendar months and 367 starts per series. This keeps edits compact and
makes complete conflict checks possible. Range reads expand only the requested
view; the 93-day view limit does not shorten the conflict-checking horizon.

Exceptions use the occurrence's original start as identity, even after it moves.
Cancellations remove intervals and overrides replace them. Changing the parent
schedule or rule with existing exceptions requires explicit exception clearing,
preventing silent reassignment of edits to a different schedule.

`ical.js` serializes calendar output, including RRULE, EXDATE and RECURRENCE-ID.
Using a calendar library avoids hand-written escaping and line-folding rules.
Scan, expansion and output limits bound expensive requests; oversized work fails
explicitly instead of returning an apparently complete partial calendar.

## Concurrency and deployment tradeoffs

Rate limits bound request frequency. They do not solve races. The owner lock
protects the check-then-save sequence across separate event documents, while
`If-Match` revision predicates prevent stale updates to the same document.
Different users can write independently.

Locks and counters are in memory, so the supported deployment has one API
process. Adding replicas requires shared rate counters and database-coordinated
writes that preserve conflict checks. Current automated concurrency tests do not
establish capacity for thousands of simultaneous users.

Docker packages Bun and frozen production dependencies into a non-root runtime.
Compose starts MongoDB first, waits for health and stores data in a named volume.
The API's readiness endpoint pings MongoDB. Container replacement preserves data;
removing the volume does not. Reminder preferences can be saved, but no worker or email transport is implemented.
No emails are sent.

Startup seeds private `users` documents from the internal identity table, using
the stable account UUID as `_id`. Each profile stores username, name and a mock
email address; tokens are excluded. `$setOnInsert` preserves saved addresses on
restart. Profiles have no public endpoint and their emails are neither accepted
in event input nor exposed in authentication responses, event JSON or ICS.
The future recipient can be resolved through `event.ownerId` without copying
an address into every event. Previously disabled settings and archived
preferences remain unchanged; the disabling startup migration has been removed.

## Verification and reading order

Start with `src/routes/events/index.ts`, follow a handler into `events/services`,
then inspect its schemas and domain rules. Read `recurrence/series.ts` when
following calendar expansion, and `http/response.ts` for the public result.

Unit tests cover rules and boundary calculations. HTTP integration tests exercise
authentication, validation, real MongoDB persistence and failures through Fastify
injection. Docker smoke tests separately check the packaged runtime, networking,
readiness and persistence. Run instructions are in the [README](../README.md).
