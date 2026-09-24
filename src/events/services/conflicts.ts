import type { Collection, ObjectId } from "mongodb";
import type { EventDocument } from "../domain/model.js";
import {
  CalendarCapacityError,
  expandEvent,
  interval,
  MAX_EXPANDED_OCCURRENCES,
  MAX_SCANNED_EVENTS,
} from "../recurrence/series.js";

export class EventConflictError extends Error {
  constructor() {
    super(
      "Event overlaps another event. Change its schedule or explicitly allow conflicts.",
    );
    this.name = "EventConflictError";
  }
}

/** All finite occurrences, under the owner's lock. Limits fail closed before writes. */
export async function assertNoEventConflict(
  collection: Collection<EventDocument>,
  candidate: EventDocument,
  excludeId?: ObjectId,
): Promise<void> {
  const proposed = expandEvent(candidate)
    .map((event) => interval(event.schedule))
    .sort((a, b) => a.start - b.start);
  if (candidate.allowConflicts || proposed.length === 0) return;
  let furthestEnd = -Infinity;
  for (const item of proposed) {
    if (item.start < furthestEnd) throw new EventConflictError();
    furthestEnd = Math.max(furthestEnd, item.end);
  }
  const start = proposed[0]!.start;
  const end = furthestEnd;
  const from = new Date(start + 28800000).toISOString().slice(0, 10);
  const roundedEnd = new Date(
    Math.ceil((end + 28800000) / 86400000) * 86400000,
  ).toISOString();
  // An exclusive ceiling beyond year 9999 sorts after every supported date.
  const to = roundedEnd.startsWith("+")
    ? "9999-12-32"
    : roundedEnd.slice(0, 10);
  const cursor = collection
    .find({
      ownerId: candidate.ownerId,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
      $or: [
        { recurrence: { $exists: true } },
        {
          "schedule.kind": "timed",
          "schedule.startsAt": { $lt: new Date(end) },
          "schedule.endsAt": { $gt: new Date(start) },
        },
        {
          "schedule.kind": "all-day",
          "schedule.startsOn": { $lt: to },
          "schedule.endsOn": { $gt: from },
        },
      ],
    })
    .limit(MAX_SCANNED_EVENTS + 1)
    .maxTimeMS(5000)
    .batchSize(10);
  let scanned = 0;
  const budget = { remaining: MAX_EXPANDED_OCCURRENCES - proposed.length };
  try {
    for await (const event of cursor) {
      if (++scanned > MAX_SCANNED_EVENTS) throw new CalendarCapacityError();
      const existing = expandEvent(event, budget)
        .map((item) => interval(item.schedule))
        .sort((a, b) => a.start - b.start);
      let a = 0,
        b = 0;
      while (a < proposed.length && b < existing.length) {
        const left = proposed[a]!,
          right = existing[b]!;
        if (left.start < right.end && right.start < left.end)
          throw new EventConflictError();
        if (left.end <= right.start) a++;
        else b++;
      }
    }
  } finally {
    await cursor.close();
  }
}
