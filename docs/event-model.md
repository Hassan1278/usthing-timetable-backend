## Three representations

1. **Create request:** fields a client is allowed to submit.
2. **Stored document:** validated, normalized event data plus ownership and
   server-controlled metadata.
3. **API response:** an explicit public representation, exposing MongoDB's `_id`
   as a string named `id`.

TypeBox schemas will validate requests. TypeScript types will describe the data
used by application code. Neither automatically creates a MongoDB collection
validator. MongoDB stores documents in an `events` collection; its collection
and indexes will be configured separately.

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
resolved email settings and leaves its input unchanged. Call it after request
validation and before storage. It does not validate untrusted input, schedule
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
revision, and timestamps. A new series has an empty exceptions list.

## Validation and implementation order

`src/events/validation.ts` implements `validateEvent` for a complete,
schema-validated event. Timed ends must follow starts as actual instants;
all-day ends must follow starts as Hong Kong calendar dates. Equal endpoints
are rejected. Past events remain allowed. Failures throw `EventValidationError`,
which the future HTTP endpoints must map to a 400 response. The function does
not change the input or allow a client-selected timezone.

The create flow is: authenticate, validate the request schema, validate business
rules, apply defaults, then add server-controlled fields and save. Updates must
validate the complete merged event before saving.

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
