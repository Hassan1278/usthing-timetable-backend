import { type Collection, ObjectId } from "mongodb";
import { Compile } from "typebox/compile";
import { applyCreateEventDefaults } from "../domain/defaults.js";
import type { EventDocument } from "../domain/model.js";
import { reminderScheduleChanged } from "../domain/reminders.js";
import { EventValidationError, validateEvent } from "../domain/validation.js";
import {
  eventInput,
  expandEvent,
  storedSchedule,
} from "../recurrence/series.js";
import { type CreateEventInput, CreateEventSchema } from "../schemas/event.js";
import type { PatchEventInput } from "../schemas/mutation.js";
import { assertNoEventConflict } from "./conflicts.js";
import { getEvent } from "./events.js";
import { withEventWriteLock } from "./write-lock.js";

const candidateValidator = Compile(CreateEventSchema);

export class EventRevisionError extends Error {
  constructor() {
    super("Event changed. Fetch the latest event before trying again.");
    this.name = "EventRevisionError";
  }
}

/** Patch and ID must pass their schemas; expectedRevision comes from If-Match. */
export async function updateEvent(
  collection: Collection<EventDocument>,
  id: string,
  ownerId: string,
  expectedRevision: number,
  patch: PatchEventInput,
): Promise<EventDocument | null> {
  return withEventWriteLock(collection, ownerId, async (session) => {
    const current = await getEvent(collection, id, ownerId, session);
    if (!current) return null;
    if (current.revision !== expectedRevision) throw new EventRevisionError();

    const { clearExceptions, recurrence, ...fields } = patch;
    const structuralChange =
      patch.schedule !== undefined || recurrence !== undefined;
    if (structuralChange && current.exceptions?.length && !clearExceptions)
      throw new EventValidationError(
        "Changing a series schedule or rule requires clearExceptions: true.",
      );
    const candidate: CreateEventInput = { ...eventInput(current), ...fields };
    if (recurrence === null) delete candidate.recurrence;
    else if (recurrence !== undefined) candidate.recurrence = recurrence;
    if (!candidateValidator.Check(candidate))
      throw new EventValidationError(
        "Updated event does not match the event schema.",
      );
    validateEvent(candidate);
    const normalized = applyCreateEventDefaults(candidate);
    const next: EventDocument = {
      ...current,
      ...normalized,
      schedule: storedSchedule(normalized.schedule),
      exceptions: clearExceptions ? [] : (current.exceptions ?? []),
      updatedAt: new Date(),
    };
    if (!normalized.recurrence) delete next.recurrence;
    expandEvent(next);
    await assertNoEventConflict(collection, next, current._id, session);

    const updated = await collection.findOneAndUpdate(
      { _id: current._id, ownerId, revision: expectedRevision },
      {
        $set: {
          ...normalized,
          schedule: next.schedule,
          ...(next.exceptions?.length ? { exceptions: next.exceptions } : {}),
          updatedAt: next.updatedAt,
          ...(reminderScheduleChanged(current, next)
            ? { remindersPending: true }
            : {}),
        },
        $unset: {
          ...(!normalized.recurrence ? { recurrence: "" as const } : {}),
          ...(!next.exceptions?.length ? { exceptions: "" as const } : {}),
        },
        $inc: { revision: 1 },
      },
      { returnDocument: "after", session },
    );
    // The atomic predicate also detects edits/deletion after our initial read.
    if (!updated) throw new EventRevisionError();
    return updated;
  });
}

/** Returns false for missing/foreign events; stale owned revisions throw. */
export async function deleteEvent(
  collection: Collection<EventDocument>,
  id: string,
  ownerId: string,
  expectedRevision: number,
): Promise<boolean> {
  return withEventWriteLock(collection, ownerId, async (session) => {
    const result = await collection.deleteOne(
      {
        _id: new ObjectId(id),
        ownerId,
        revision: expectedRevision,
      },
      { session },
    );
    if (result.deletedCount === 1) return true;
    if (await getEvent(collection, id, ownerId, session))
      throw new EventRevisionError();
    return false;
  });
}
