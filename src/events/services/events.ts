import { randomUUID } from "node:crypto";
import { type Collection, type Filter, ObjectId } from "mongodb";
import { applyCreateEventDefaults } from "../domain/defaults.js";
import type { EventDocument } from "../domain/model.js";
import { EventValidationError, validateEvent } from "../domain/validation.js";
import type { ExpandedEvent } from "../recurrence/series.js";
import { expandEvent } from "../recurrence/series.js";
import type { CreateEventInput } from "../schemas/event.js";
import {
  CALENDAR_RANGE_MAX_DAYS,
  type ListEventsQuery,
} from "../schemas/query.js";
import { listCalendarOccurrences } from "./calendar.js";
import { assertNoEventConflict } from "./conflicts.js";
import { withEventWriteLock } from "./write-lock.js";

/** Input must pass CreateEventSchema; ownerId must come from authentication. */
export async function createEvent(
  collection: Collection<EventDocument>,
  input: CreateEventInput,
  ownerId: string,
): Promise<EventDocument> {
  validateEvent(input);
  const normalized = applyCreateEventDefaults(input);
  const now = new Date();
  const event: EventDocument = {
    ...normalized,
    schedule:
      normalized.schedule.kind === "timed"
        ? {
            kind: "timed",
            startsAt: new Date(normalized.schedule.startsAt),
            endsAt: new Date(normalized.schedule.endsAt),
          }
        : { ...normalized.schedule },
    _id: new ObjectId(),
    ownerId,
    uid: randomUUID(),
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };

  expandEvent(event);
  return withEventWriteLock(collection, ownerId, async () => {
    await assertNoEventConflict(collection, event);
    await collection.insertOne(event);
    return event;
  });
}

/** ID must pass EventIdParamsSchema; ownership is part of the database query. */
export async function getEvent(
  collection: Collection<EventDocument>,
  id: string,
  ownerId: string,
): Promise<EventDocument | null> {
  return collection.findOne({ _id: new ObjectId(id), ownerId });
}

/** Query must pass ListEventsQuerySchema. Ranged reads expand finite series. */
export async function listEvents(
  collection: Collection<EventDocument>,
  query: ListEventsQuery,
  ownerId: string,
): Promise<{ events: ExpandedEvent[]; nextCursor: string | null }> {
  if (query.from !== undefined && query.to !== undefined)
    return listCalendarOccurrences(collection, query, ownerId);
  if (query.after?.includes("~"))
    throw new EventValidationError("Occurrence cursors require a date range.");
  const filter = buildEventFilter(query, ownerId);

  const limit = Number(query.limit ?? "50");
  const documents = await collection
    .find(filter)
    .sort({ _id: 1 })
    .limit(limit + 1)
    .toArray();
  const events = documents.slice(0, limit);
  const last = events.at(-1);
  return {
    events,
    nextCursor:
      documents.length > limit && last ? last._id.toHexString() : null,
  };
}

/** Shared owner and HK-range predicates for JSON listing and ICS export. */
export function buildEventFilter(
  query: ListEventsQuery,
  ownerId: string,
): Filter<EventDocument> {
  const { from, to, after } = query;
  if ((from === undefined) !== (to === undefined)) {
    throw new EventValidationError("from and to must be supplied together.");
  }

  const filter: Filter<EventDocument> = {
    ownerId,
    recurrence: { $exists: false },
    ...(after ? { _id: { $gt: new ObjectId(after) } } : {}),
  };

  if (from !== undefined && to !== undefined) {
    // Date-range boundaries are midnight in the fixed Hong Kong timetable.
    const start = new Date(`${from}T00:00:00+08:00`);
    const end = new Date(`${to}T00:00:00+08:00`);
    const days = (end.getTime() - start.getTime()) / 86_400_000;
    if (!(days > 0 && days <= CALENDAR_RANGE_MAX_DAYS)) {
      throw new EventValidationError(
        "Date range must be between 1 and 93 days.",
      );
    }
    filter.$or = [
      {
        "schedule.kind": "timed",
        "schedule.startsAt": { $lt: end },
        "schedule.endsAt": { $gt: start },
      },
      {
        "schedule.kind": "all-day",
        "schedule.startsOn": { $lt: to },
        "schedule.endsOn": { $gt: from },
      },
    ];
  }

  return filter;
}
