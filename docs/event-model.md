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

The current storage type covers non-recurring events. The recurrence and
exception fields below describe the planned extension; their concrete types
will be added with that feature.

## Reading events

`GET /events/:id` queries by both event ID and authenticated owner ID. A missing
event and another owner's event both return `404`; an invalid ID returns `400`.

`GET /events` lists the owner's non-recurring events. Optional paired `from` and
`to` date strings restrict results to a window of 1–93 Hong Kong calendar days,
with an exclusive end. Timed overlaps use BSON dates with boundaries at Hong
Kong midnight; all-day overlaps compare date strings. Both use start-before-end
and end-after-start inequalities, including events spanning the entire window.
The current query excludes documents where `recurrence` exists. When recurrence
is implemented, the range query will expand series into occurrences; the
unfiltered listing will continue to exclude them.

`limit` defaults to 50 and accepts integer query text from 1 to 100. Lists use
ascending `_id` order with an optional `after` ObjectId cursor and return
`{ items, nextCursor }`. Queries fetch at most `limit + 1` documents to determine
whether another page exists. Reuse the range filters on each page. Pagination
does not create a snapshot, and IDs determine page order rather than event time.
`src/events/query-schemas.ts` rejects unknown query fields and malformed values;
the service validates paired range dates and duration before querying MongoDB.

## Event fields

| Field | Meaning | Controlled by |
| --- | --- | --- |
| `_id` | MongoDB identifier for this event or series | Server |
| `ownerId` | Stable UUID of the account that owns the event | Authentication |
| `title` | Required event name | User |
| `description` | Optional plain-text details | User |
| `location` | Optional location | User |
| `eventType` | `class`, `appointment`, `club`, `study`, `personal`, or `other` | User |
| `isOptional` | Whether the user considers attendance optional | User |
| `schedule` | Timed or all-day schedule | User |
| `recurrence` | Optional rule describing repeated occurrences | User |
| `exceptions` | Cancelled or modified occurrences of a series | Dedicated authenticated operations |
| `emailNotifications` | Whether email is enabled and when reminders are due | User; server resolves defaults |
| `uid` | Stable calendar identity used for ICS import/export | Server or validated import |
| `revision` | Integer used to detect stale edits, starting at 1 | Server |
| `createdAt` | Creation timestamp | Server |
| `updatedAt` | Most recent modification timestamp | Server |

The server derives `ownerId` from `request.user.id`. Every event lookup, update,
and deletion must be restricted to that owner. A valid token alone does not
grant access to another user's events.

Create requests must not set `_id`, `id`, `ownerId`, `uid`, `revision`,
`createdAt`, `updatedAt`, or `exceptions`. The import endpoint handles imported
UIDs and exceptions through a separate validation path.

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
Hong Kong calendar time. ICS import must interpret source timezone information
before converting instants. Source recurrence affected by daylight saving must
preserve the actual occurrence times or be explicitly rejected as unsupported;
it must not silently become a different Hong Kong recurrence.

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

The recurrence model must support daily, weekly, monthly, and yearly frequency;
a positive interval; calendar selectors; and an optional end date or occurrence
count. For example, a weekly club meeting can repeat every Monday and Wednesday
until the end of the semester.

The precise recurrence request schema will be specified in the recurrence
milestone, including mappings to ICS rules. Open-ended series are permitted,
but expansion must have date-range, iteration, and output limits.

Each exception identifies an occurrence by its **original scheduled start**,
even if that occurrence moves to another date. An exception either cancels the
occurrence or overrides its permitted event fields. Overrides cannot change
ownership or create a nested recurring series.

Changing a series schedule or recurrence while exceptions exist requires the
user to explicitly clear those exceptions. Metadata-only edits preserve them.
Editing “this and all future occurrences” is outside the initial version.

## Optional attendance and conflicts

`isOptional` is a required boolean describing attendance. It is not permission
to ignore the event during conflict detection and does not control email.

Occurrences overlap when:

```text
existingStart < proposedEnd AND existingEnd > proposedStart
```

An event ending exactly when another starts does not conflict. Conflict results
include whether the affected events are optional, so a client can explain the
choice. Conflicts are warnings and do not block saving.

Conflict checks consider the current user's effective occurrences, including
exclusions and moved instances. Results must state the interval checked and
must not imply that an open-ended series was checked forever.

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
emails, or apply update/import rules; those paths will be implemented separately.

## Example create request

```json
{
  "title": "Doctor appointment",
  "description": "Bring appointment confirmation",
  "location": "Campus clinic",
  "eventType": "appointment",
  "isOptional": false,
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
revision, and timestamps. Recurrence and exception storage are future work.

## Validation and implementation order

`src/events/validation.ts` implements `validateEvent` for a complete,
schema-validated event. Timed ends must follow starts as actual instants;
all-day ends must follow starts as Hong Kong calendar dates. Equal endpoints
are rejected. Past events remain allowed. Failures throw `EventValidationError`,
which `POST /events` maps to a 400 response. The function does
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

Implement the base request schemas and tests first, then normalization and
domain validation, the stored-document type, and the MongoDB collection/indexes.
Build CRUD before adding recurrence, conflicts, ICS import/export, and reminder
delivery. Each milestone includes its own tests and documentation updates.
