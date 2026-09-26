import type { Collection } from "mongodb";
import { Compile } from "typebox/compile";
import type { EventDocument } from "../domain/model.js";
import { EventValidationError } from "../domain/validation.js";
import { baseOccurrences, expandEvent } from "../recurrence/series.js";
import { OccurrencePatchSchema } from "../schemas/exception.js";
import { assertNoEventConflict } from "./conflicts.js";
import { getEvent } from "./events.js";
import { EventRevisionError } from "./mutations.js";
import { withEventWriteLock } from "./write-lock.js";

const patchValidator = Compile(OccurrencePatchSchema);
export async function changeOccurrence(
  collection: Collection<EventDocument>,
  id: string,
  ownerId: string,
  revision: number,
  originalStart: string,
  action: "edit" | "cancel" | "restore",
  patch?: unknown,
): Promise<EventDocument | null> {
  return withEventWriteLock(collection, ownerId, async () => {
    const current = await getEvent(collection, id, ownerId);
    if (!current) return null;
    if (current.revision !== revision) throw new EventRevisionError();
    if (!current.recurrence)
      throw new EventValidationError("Event is not a recurring series.");
    if ((current.schedule.kind === "timed") !== originalStart.includes("T"))
      throw new EventValidationError(
        "originalStart must match the series date/time kind.",
      );
    const key =
      current.schedule.kind === "timed" &&
      Number.isFinite(Date.parse(originalStart))
        ? new Date(originalStart).toISOString()
        : originalStart;
    if (!baseOccurrences(current).some((item) => item.originalStart === key))
      return null;
    const previous = current.exceptions?.find(
      (item) => item.originalStart === key,
    );
    const exceptions = (current.exceptions ?? []).filter(
      (item) => item.originalStart !== key,
    );
    if (action === "edit") {
      if (!patchValidator.Check(patch))
        throw new EventValidationError("Invalid occurrence patch.");
      exceptions.push({
        originalStart: key,
        cancelled: false,
        patch: {
          ...(previous && !previous.cancelled ? previous.patch : {}),
          ...patch,
        },
      });
    } else if (action === "cancel")
      exceptions.push({ originalStart: key, cancelled: true });
    const next = { ...current, exceptions, updatedAt: new Date() };
    expandEvent(next);
    // Cancellation can only remove intervals. Restore/edit can introduce overlaps.
    if (action !== "cancel")
      await assertNoEventConflict(collection, next, current._id);
    const updated = await collection.findOneAndUpdate(
      { _id: current._id, ownerId, revision },
      {
        $set: { exceptions, updatedAt: next.updatedAt, remindersPending: true },
        $inc: { revision: 1 },
      },
      { returnDocument: "after" },
    );
    if (!updated) throw new EventRevisionError();
    return updated;
  });
}
