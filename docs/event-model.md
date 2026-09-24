## Three representations

1. **Create request:** fields a client is allowed to submit.
2. **Stored document:** validated, normalized event data plus ownership and
   server-controlled metadata.
3. **API response:** an explicit public representation, exposing MongoDB's `_id`
   as a string named `id`.

TypeBox schemas will validate requests. TypeScript types will describe the data
used by application code. Neither automatically creates a MongoDB collection
validator. MongoDB stores documents in an `events` collection; the database
plugin configures the collection and indexes separately from these types.

`src/events/model.ts` defines the current `EventDocument` storage type. It reuses
the validated event fields and resolved email settings, replaces timed schedule
strings with JavaScript `Date` values (serialized by MongoDB as BSON dates), and
requires an `ObjectId`, owner ID, calendar UID, revision, and timestamps. All-day
dates remain strings in the fixed Hong Kong timetable. The type describes these
fields; `src/events/service.ts` converts schedules, resolves defaults, generates
metadata, and inserts the document after business validation. Its input must
already have passed request-schema validation.

`src/plugins/init-mongo.ts` registers the typed collection as
`fastify.collections.events` and creates the unique compound index
`{ ownerId: 1, uid: 1 }` before the app becomes ready. One owner cannot store
the same calendar UID twice, but different owners can share a UID. The index's
owner prefix also supports owner-based lookups, so a separate owner-only index
is unnecessary. MongoDB also provides the unique `_id` index automatically.
An `{ ownerId: 1, _id: 1 }` index supports cursor pagination. Two additional
indexes start with owner and schedule kind, followed by `schedule.startsAt`
or `schedule.startsOn`, to support timed and all-day range filtering. The end
boundary is also checked in the query; an index does not replace overlap rules.
Indexes do not enforce authorization: every event operation must still filter
by the authenticated owner. No MongoDB collection validator is installed yet.

The storage type covers normal events and finite recurring series, with resolved
recurrence rules and embedded cancellation or modification exceptions.
See [recurrence.md](recurrence.md) for the complete endpoint and limit contract.

## Reading events

`GET /events/:id` queries by both event ID and authenticated owner ID. A missing
event and another owner's event both return `404`; an invalid ID returns `400`.

`GET /events` lists the owner's non-recurring events. Optional paired `from` and
`to` date strings restrict results to a window of 1–93 Hong Kong calendar days,
with an exclusive end. Timed overlaps use BSON dates with boundaries at Hong
Kong midnight; all-day overlaps compare date strings. Both use start-before-end
and end-after-start inequalities, including events spanning the entire window.
Ranged queries expand recurring series and apply exceptions before overlap
filtering, including moved-in instances. Unfiltered listing excludes series.

`limit` defaults to 50 and accepts integer query text from 1 to 100. Lists use
ascending `_id` order with an optional `after` ObjectId cursor and return
`{ items, nextCursor }`. Queries fetch at most `limit + 1` documents to determine
whether another page exists. Reuse the range filters on each page. Pagination
does not create a snapshot, and IDs determine page order rather than event time.
`src/events/query-schemas.ts` rejects unknown query fields and malformed values;
the service validates paired range dates and duration before querying MongoDB.

## ICS export

`GET /events/export.ics` uses the same authenticated owner and optional paired
Hong Kong range filters as JSON listing. It returns a complete selection up to
1000 scanned parent events; larger selections return 413 with no partial file.
It rejects pagination and timezone parameters. An empty selection produces a
valid calendar without VEVENT entries. The shared authenticated read budget applies.

`src/events/ics.ts` queries at most 1001 documents and uses `ical.js` to serialize
RFC 5545 calendar data. UID is stable across downloads and edits; SEQUENCE is
revision minus one. DTSTAMP and LAST-MODIFIED use updatedAt. Timed DTSTART/DTEND
are UTC, and all-day values use VALUE=DATE with an exclusive end. Fractional seconds
round outwards (start down, end up), because iCalendar has second precision;
this prevents a sub-second event from becoming a zero-length interval. User text is
escaped, CRLF/bare CR are normalized to LF, and invalid controls are omitted.
Recurring parents use finite RRULEs; cancellation and modification exceptions
use EXDATE and RECURRENCE-ID. Range filters select complete matching series.
The download excludes owner IDs, tokens, app-specific settings and alarms.

This is a snapshot export, not synchronization or import. The endpoint sends
`text/calendar`, an attachment filename and `private, no-store` cache policy.
See the [README](../README.md#exporting-an-ics-calendar) for usage, the
[ical.js API](https://kewisch.github.io/ical.js/api/ICAL.Component.html) for the
serializer, and [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545) for the format.

## Event fields

| Field | Meaning | Controlled by |
| --- | --- | --- |
| `_id` | MongoDB identifier for this event or series | Server |
| `ownerId` | Stable UUID of the account that owns the event | Authentication |
| `title` | Required event name | User |
| `description` | Optional plain-text details | User |
| `location` | Optional location | User |
| `eventType` | `class`, `appointment`, `club`, `study`, `personal`, or `other` | User |
| `allowConflicts` | Explicit permission to save despite overlaps | User |
| `schedule` | Timed or all-day schedule | User |
| `recurrence` | Optional rule describing repeated occurrences | User |
| `exceptions` | Cancelled or modified occurrences of a series | Dedicated authenticated operations |
| `emailNotifications` | Whether email is enabled and when reminders are due | User; server resolves defaults |
| `uid` | Stable calendar identity used for ICS export | Server |
| `revision` | Integer used to detect stale edits, starting at 1 | Server |
| `createdAt` | Creation timestamp | Server |
| `updatedAt` | Most recent modification timestamp | Server |

The server derives `ownerId` from `request.user.id`. Every event lookup, update,
and deletion must be restricted to that owner. A valid token alone does not
grant access to another user's events.

Create requests must not set `_id`, `id`, `ownerId`, `uid`, `revision`,
`createdAt`, `updatedAt`, or `exceptions`. There is no ICS import endpoint.

## Schedule

The timetable uses the fixed timezone `Asia/Hong_Kong`. Clients cannot supply
or change `timeZone`; that property is rejected in event requests. The `kind`
field selects one of two shapes.

### Timed event

```json
{
  "kind": "timed",
  "startsAt": "2026-10-05T10:00:00+08:00",
  "endsAt": "2026-10-05T11:00:00+08:00"
}
```

Inputs must contain valid date-times with an explicit UTC offset or `Z`.
The end must be after the start. Different offsets can describe the same
instant: `2026-10-05T02:00:00Z` is 10:00 in Hong Kong. Accepting that timestamp
does not change the timetable timezone.

Store the first start/end instants as BSON dates. Recurring occurrences follow
Hong Kong calendar time. ICS export represents stored timed instants in UTC;
this does not change the timetable timezone. Import is outside the current scope.

### All-day event

```json
{
  "kind": "all-day",
  "startsOn": "2026-10-05",
  "endsOn": "2026-10-06"
}
```

Store all-day dates as `YYYY-MM-DD` strings. The end date is exclusive: the
example covers only 5 October. The end must be later than the start. Hong Kong
time supplies the context for conflict calculations and reminders, without
turning the stored dates into UTC dates.

## Recurrence and exceptions

An event without `recurrence` occurs once. A recurring series is stored once,
and its occurrences are calculated for a requested date range.

The optional `recurrence` field applies to the existing timed or all-day event.
The schedule defines its first occurrence and duration; it is still required.
Supported frequencies are `daily` (every day) and `weekly` (every seven days,
on the first occurrence's weekday), in the fixed Hong Kong timetable.

```json
{
  "recurrence": {
    "frequency": "weekly",
    "endsOn": "2027-05-31"
  }
}
```

`endsOn` is an optional date-only, inclusive last occurrence **start** date.
Omitting it means 12 calendar months after the first Hong Kong start date,
not after today. February 29 clamps to February 28 the following year. Explicit
ends must be on or after the first start date and no later than that default.
The final occurrence may finish after this date. There are no infinite series.
Omitting `recurrence` means a single event; null and empty recurrence objects
are invalid. Interval, count, weekday selectors, timezone fields, monthly/yearly
frequencies and inline exceptions are not accepted.

`src/events/recurrence-schema.ts` supplies the strict input shape and types.
`src/events/recurrence.ts` supplies a pure, tested end-date resolver that must run
after schema validation. Schema validation checks structure and calendar-date
validity; the resolver checks schedule-relative limits without mutating input.
The resolved end is saved once and preserved on reads and unrelated edits.

Recurrence is enabled for create/read/update/delete, full-series conflict checks,
individual occurrence operations, and ICS export. The parent embeds its exceptions
so one atomic revision-protected update saves an occurrence change.

Each exception identifies an occurrence by its **original scheduled start**,
even if that occurrence moves to another date. An exception either cancels the
occurrence or overrides its permitted event fields. Overrides cannot change
ownership or create a nested recurring series.

Changing a series schedule or recurrence while exceptions exist requires the
user to explicitly clear those exceptions. Metadata-only edits preserve them.
Editing “this and all future occurrences” is outside the initial version.

## Bounded occurrence generation

`src/events/occurrences.ts` generates timed or all-day schedules from a source
schedule, optional **resolved** recurrence, and a required `from`/`to` range.
It validates all inputs at runtime, including unknown fields and schedule order.
Date ranges are exclusive at `to`, use Hong Kong midnight and allow 1–93 days.
A missing recurrence means zero or one occurrence; an unresolved recurrence is
rejected rather than receiving a moving end-date default on reads.

For period P and original interval [start, end), candidate indexes are:

```text
first = max(0, floor((rangeStart - end) / P) + 1)
last  = min(lastSeriesIndex, ceil((rangeEnd - start) / P) - 1)
```

This includes occurrences that begin before the range and finish inside it,
while excluding exact endpoint touches. Daily/weekly periods use fixed 24-hour
Hong Kong days. The recurrence end limits occurrence starts, not their finishes.
Only matching indexes are generated; distant ranges do not cause a walk through
all intervening dates. A finite 12-month daily series has at most 367 starts,
including both endpoints across a leap year. Longer-duration events may overlap
one another, so the generator returns them all rather than hiding conflicts.
Overflow or invalid rules fail without partial output. This low-level helper accepts only a base rule; `series.ts` applies validated
exceptions before reads and conflict checks.

Generated results are not database records and do not authorize any operation.
Each has an `originalStart` (UTC timestamp for timed events, date for all-day
ones) and schedule. HTTP services load the series using the
**authenticated owner**, pair its ID with originalStart, and revalidate occurrence
membership for edits/deletions. Never accept a client-generated occurrence as
proof of ownership or of a valid appointment. Normal reads must not write the
occurrences to MongoDB.

Ranged GET calls this machinery through the bounded calendar read service.
Full-series generation is separate from the 93-day viewing limit: all finite
occurrences are checked on writes. Scans have a 1000-document and 100,000-start
budget and fail with 413 instead of truncating. Auth, revisions, per-owner locks
and rate limits apply to normal and occurrence operations alike.

## Allowing conflicts

`allowConflicts` is a required boolean expressing whether the event may overlap
other events. It does not describe attendance and does not control email.
The backend checks every create and update. False rejects an overlap with
`409 Conflict` before saving; true permits the operation. The error describes
the conflict without returning a list of event details. This applies to the
event being saved. Existing events remain part of overlap detection regardless
of their own setting.

Occurrences overlap when:

```text
existingStart < proposedEnd AND existingEnd > proposedStart
```

An event ending exactly when another starts does not conflict. The current API
returns a conflict message; a detailed conflict-list response is future work.

Current checks cover normal events and every effective recurring occurrence,
including self-overlap, cancellations and modified schedules.

## Email notifications

Disabled:

```json
{ "enabled": false }
```

Enabled with default timings:

```json
{ "enabled": true }
```

Enabled with custom timings:

```json
{ "enabled": true, "minutesBefore": [1440, 120] }
```

- `enabled` is a boolean. When false, `minutesBefore` is not accepted.
- When true and timings are omitted, resolve defaults to `[1440, 120]`:
  24 hours and 2 hours before the occurrence.
- Custom timings contain 1–3 unique integers from 0 to 10080 inclusive.
  Zero means at the start; 10080 means seven days before.
- For manual creation, an omitted `emailNotifications` field enables the
  defaults for appointments and disables email for other event types.
- Explicit settings always override event-type defaults. A class can have
  emails enabled, and an appointment can have them disabled.
- Store enabled notifications with their resolved timings. Defaults must not
  be recalculated whenever the event is read.
- In a partial update, an omitted notification field leaves settings unchanged.
  A supplied notification object replaces the previous settings. Changing
  `eventType` alone does not reset reminders.
- Skip reminder times already passed when an event is created. All-day reminders
  use 09:00 in `Asia/Hong_Kong` as their reference time.
- Imported events default to backend email disabled. Imported calendar alarms
  do not authorize sending backend emails.
- The recipient comes from the authenticated account configuration, never from
  an event request. Recipient configuration and delivery are later work.

A background worker will handle delivery and recheck that the event and reminder
still exist before sending. Creating an event does not itself send an email.

`src/events/defaults.ts` implements reminder defaults for validated manual
create requests. `applyCreateEventDefaults` returns a new event object with
resolved email settings and leaves its input unchanged. The creation service
calls it after validation and before storage. It does not validate untrusted input, schedule
emails, or apply update/import omission rules. The update service preserves
omitted settings and uses the shared `resolveEmailNotifications` function only
for explicitly supplied notification settings. Import remains future work.

## Example create request

```json
{
  "title": "Doctor appointment",
  "description": "Bring appointment confirmation",
  "location": "Campus clinic",
  "eventType": "appointment",
  "allowConflicts": false,
  "schedule": {
    "kind": "timed",
    "startsAt": "2026-10-05T10:00:00+08:00",
    "endsAt": "2026-10-05T11:00:00+08:00"
  },
  "emailNotifications": {
    "enabled": true
  }
}
```

Before insertion, the server validates the request, resolves reminder defaults,
normalizes schedule values, and adds the event ID, owner ID, calendar UID,
revision, timestamps, resolved recurrence and embedded exceptions.

## Validation and implementation order

`src/events/validation.ts` implements `validateEvent` for a complete,
schema-validated event. Timed ends must follow starts as actual instants;
all-day ends must follow starts as Hong Kong calendar dates. Equal endpoints
are rejected. Past events remain allowed. Failures throw `EventValidationError`,
which POST and PATCH map to a 400 response. The function does
not change the input or allow a client-selected timezone.

The create flow is: authenticate, validate the request schema, validate business
rules, apply defaults, then add server-controlled fields and save. Updates must
validate the complete merged event before saving.

`src/routes/events/index.ts` connects this flow to `POST /events` inside a
`withAuth` scope. Its TypeBox validator checks the request without stripping
unknown properties, coercing types, or injecting defaults. This rejects
client-supplied ownership, metadata, and `timeZone` fields. On success,
`src/events/response.ts` maps the stored document to an explicit public response
with `id` and ISO timestamp strings, excluding `_id` and `ownerId`. UTC (`Z`)
timestamps represent the same instants in the fixed Hong Kong timetable.

- Require a nonblank title of at most 120 characters; allow an optional
  description up to 2000 characters and location up to 200 characters.
- Validate event types, booleans, schedule shapes, and reminder limits at runtime.
- Reject unexpected request properties. Configure and test the HTTP validator
  to reject them rather than silently remove them.
- Validate field relationships, such as end-after-start, before database writes.
- Validate the complete candidate event after merging a partial update.
- Check revision and ownership together when applying updates or deletions.

## Updates and deletion

`src/events/mutation-schemas.ts` derives the PATCH body from the create schema,
making only top-level fields optional and rejecting empty patches. Nested
schedule, recurrence and email objects replace their previous values. Only
recurrence accepts null, which removes repetition;
an empty description or location string clears its displayed text.

`src/events/mutations.ts` reads the owned event and merges permitted fields,
then checks the complete candidate against the create schema and business rules.
It preserves omitted reminder settings, resolves explicitly supplied timings,
and normalizes dates before writing. ID, owner, UID and creation time remain
unchanged. Every successful update changes `updatedAt` and increments revision.

Both PATCH and DELETE require the current quoted revision in `If-Match`.
POST, single-event GET and PATCH expose this value through `ETag`, also made
readable by browser clients through CORS. Missing preconditions return `428`,
malformed headers return `400`, and stale revisions return `412`. Fetch current
state before retrying a stale edit. Missing or foreign events return `404`.

MongoDB applies ownership and revision predicates in the same atomic operation
as the update or deletion. The initial PATCH read alone is not a concurrency
guarantee: `findOneAndUpdate` must still match the revision when writing. DELETE
uses `deleteOne` with the same conditions and returns an empty `204` on success.
An event already absent when PATCH begins returns `404`. Atomic revision
predicates remain necessary even though same-owner API writes are serialized.
There is no background job queue for CRUD.

`src/events/conflicts.ts` checks half-open intervals against the same owner's
stored events, converting all-day boundaries to Hong Kong instants. PATCH
excludes its own ID. A bounded cursor fetches potentially relevant normal
events and recurring parents; effective intervals are compared in start order. It includes existing events regardless of their allowConflicts
setting; the candidate's flag determines whether the save may proceed.

`src/events/write-lock.ts` serializes create, update and delete for one owner
within a single API process. Conflict checking and writing occur inside this
critical section. Releasing in a finally block prevents failed requests from
blocking later writes; idle owner entries are removed. Different owners and
reads do not share a lock. This is not a distributed lock. Before multiple API
replicas or additional write paths are enabled, replace it with database-level
coordination (for example a transaction with a per-owner coordination document
on a replica set) and add cross-instance race tests. A transaction containing
only an overlap read and an independent event insert is not sufficient to
serialize competing calendar writes.

Base CRUD, input validation, defaults, storage types, indexes and tests are
implemented. Basic backend conflict rejection is also implemented. Remaining
milestones include reminder delivery. Recurrence and ICS export are implemented;
ICS import is outside the current scope. API
container setup is implemented and verified; results are recorded in
[container verification](container-verification.md). Each milestone includes tests and documentation updates.

## Request rate limits

`src/rate-limits.ts` registers `@fastify/rate-limit` before application routes.
An onRequest hook applies a shared IP budget before authentication. A preParsing
hook then applies authenticated user budgets before parsing and validation:
GET/HEAD share the read budget; other authenticated methods share the write
budget. Keys use the verified user ID, never a client-supplied ID or raw token.
POST, PATCH and DELETE therefore consume the same write allowance. Invalid
requests consume any budgets they reach. CORS preflight handled by the earlier
CORS hook does not consume allowance.

Defaults per 60-second fixed window are 120 requests per IP, 120 reads per user,
and 30 writes per user. Both IP and user checks must pass. All users sharing an
IP share its budget; limits should be tuned for campus networks and actual load.
Requests exceeding a budget return 429 with Retry-After in seconds. Response
headers X-RateLimit-Scope, X-RateLimit-Limit, X-RateLimit-Remaining and
X-RateLimit-Reset describe the last checked budget; reset is seconds remaining,
not a Unix timestamp. Counter errors fail closed.

The plugin's supported custom-store interface uses `src/rate-limit-store.ts`
to return independent counter snapshots, avoiding mutable counter races in
simultaneous requests. Each in-memory store retains up to 5000 keys using LRU
replacement. Restarting the process or evicting a key resets that allowance.
These are per-process traffic controls, not a distributed abuse-prevention
system. Multiple API replicas require a shared store such as Redis. Deployment
behind a proxy must explicitly trust only the known proxy addresses; the current
server does not trust arbitrary forwarded IP headers. IPv6 IP limits group /64
subnets using the rate-limit plugin's normalization.

Atomic ownership/revision predicates still protect competing writes. Rate
limiting does not replace the write lock or the atomic revision checks.
