import { type Collection, ObjectId } from "mongodb";
import type { EventDocument } from "./model.js";
import type { ListEventsQuery } from "./query-schemas.js";
import {
  CalendarCapacityError,
  type ExpandedEvent,
  expandEvent,
  MAX_EXPANDED_OCCURRENCES,
  MAX_SCANNED_EVENTS,
  overlapsRange,
} from "./series.js";
import { buildEventFilter } from "./service.js";
import { EventValidationError } from "./validation.js";

/** Live cursor ordered by parent ID and original start, not moved schedule time. */
export async function listCalendarOccurrences(
  collection: Collection<EventDocument>,
  query: ListEventsQuery,
  ownerId: string,
) {
  const { after, ...withoutCursor } = query;
  const baseFilter = buildEventFilter(withoutCursor, ownerId);
  const [id, originalStart] = after?.split("~") ?? [];
  if (
    originalStart !== undefined &&
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(originalStart)
  )
    throw new EventValidationError("Invalid occurrence cursor.");
  const cursor = collection
    .find({
      ownerId,
      ...(id
        ? {
            _id: originalStart
              ? { $gte: new ObjectId(id) }
              : { $gt: new ObjectId(id) },
          }
        : {}),
      $or: [baseFilter, { recurrence: { $exists: true } }],
    })
    .sort({ _id: 1 })
    .limit(MAX_SCANNED_EVENTS + 1)
    .maxTimeMS(5000)
    .batchSize(10);
  const limit = Number(query.limit ?? "50");
  const selected: ExpandedEvent[] = [];
  let scanned = 0;
  const budget = { remaining: MAX_EXPANDED_OCCURRENCES };
  try {
    for await (const document of cursor) {
      if (++scanned > MAX_SCANNED_EVENTS) throw new CalendarCapacityError();
      const occurrences = expandEvent(document, budget);
      for (const event of occurrences) {
        if (
          originalStart &&
          document._id.toHexString() === id?.toLowerCase() &&
          (event.originalStart ?? "") <= originalStart
        )
          continue;
        if (overlapsRange(event, query.from!, query.to!)) selected.push(event);
        if (selected.length > limit) {
          const last = selected[limit - 1]!;
          return {
            events: selected.slice(0, limit),
            nextCursor: `${last._id.toHexString()}${last.originalStart ? `~${last.originalStart}` : ""}`,
          };
        }
      }
    }
  } finally {
    await cursor.close();
  }
  return { events: selected, nextCursor: null };
}
