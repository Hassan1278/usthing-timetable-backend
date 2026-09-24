import type { Collection, ObjectId } from "mongodb";
import type { EventDocument, StoredSchedule } from "./model.js";

const DAY_MS = 86_400_000;
const HK_OFFSET_MS = 8 * 60 * 60 * 1000;

export class EventConflictError extends Error {
  constructor() {
    super(
      "Event overlaps another event. Change its schedule or explicitly allow conflicts.",
    );
    this.name = "EventConflictError";
  }
}

/** Call under the owner's write lock; never rely on a frontend conflict check. */
export async function assertNoEventConflict(
  collection: Collection<EventDocument>,
  candidate: Pick<EventDocument, "ownerId" | "schedule" | "allowConflicts">,
  excludeId?: ObjectId,
): Promise<void> {
  if (candidate.allowConflicts) return;
  const { start, end } = interval(candidate.schedule);
  const startDay = new Date(start.getTime() + HK_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
  // All-day ends are exclusive. Round a timed end up to the next HK midnight,
  // unless it is already midnight; this preserves exact touching boundaries.
  const endDay = new Date(
    Math.ceil((end.getTime() + HK_OFFSET_MS) / DAY_MS) * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
  const conflict = await collection.findOne(
    {
      ownerId: candidate.ownerId,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
      $or: [
        {
          "schedule.kind": "timed",
          "schedule.startsAt": { $lt: end },
          "schedule.endsAt": { $gt: start },
        },
        {
          "schedule.kind": "all-day",
          "schedule.startsOn": { $lt: endDay },
          "schedule.endsOn": { $gt: startDay },
        },
      ],
    },
    { projection: { _id: 1 } },
  );
  if (conflict) throw new EventConflictError();
}

function interval(schedule: StoredSchedule): { start: Date; end: Date } {
  return schedule.kind === "timed"
    ? { start: schedule.startsAt, end: schedule.endsAt }
    : {
        start: new Date(`${schedule.startsOn}T00:00:00+08:00`),
        end: new Date(`${schedule.endsOn}T00:00:00+08:00`),
      };
}
