import { randomUUID } from "node:crypto";
import { type Collection, type Filter, ObjectId } from "mongodb";
import { assertNoEventConflict } from "./conflicts.js";
import { applyCreateEventDefaults } from "./defaults.js";
import type { EventDocument } from "./model.js";
import type { ListEventsQuery } from "./query-schemas.js";
import type { CreateEventInput } from "./schemas.js";
import { EventValidationError, validateEvent } from "./validation.js";
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

/** Query must pass ListEventsQuerySchema. Recurrence expansion is future work. */
export async function listEvents(
  collection: Collection<EventDocument>,
  query: ListEventsQuery,
  ownerId: string,
): Promise<{ events: EventDocument[]; nextCursor: string | null }> {
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
    if (!(days > 0 && days <= 93)) {
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
