import { type Collection, ObjectId } from "mongodb";
import { Compile } from "typebox/compile";
import { resolveEmailNotifications } from "./defaults.js";
import type { EventDocument } from "./model.js";
import type { PatchEventInput } from "./mutation-schemas.js";
import { type CreateEventInput, CreateEventSchema } from "./schemas.js";
import { getEvent } from "./service.js";
import { EventValidationError, validateEvent } from "./validation.js";

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
  const current = await getEvent(collection, id, ownerId);
  if (!current) return null;
  if (current.revision !== expectedRevision) throw new EventRevisionError();

  const candidate: CreateEventInput = {
    title: current.title,
    ...(current.description !== undefined
      ? { description: current.description }
      : {}),
    ...(current.location !== undefined ? { location: current.location } : {}),
    eventType: current.eventType,
    isOptional: current.isOptional,
    schedule:
      current.schedule.kind === "timed"
        ? {
            kind: "timed",
            startsAt: current.schedule.startsAt.toISOString(),
            endsAt: current.schedule.endsAt.toISOString(),
          }
        : { ...current.schedule },
    emailNotifications: current.emailNotifications,
    ...patch,
  };
  if (!candidateValidator.Check(candidate)) {
    throw new EventValidationError(
      "Updated event does not match the event schema.",
    );
  }
  validateEvent(candidate);

  const updated = await collection.findOneAndUpdate(
    { _id: current._id, ownerId, revision: expectedRevision },
    {
      $set: {
        ...candidate,
        schedule:
          candidate.schedule.kind === "timed"
            ? {
                kind: "timed",
                startsAt: new Date(candidate.schedule.startsAt),
                endsAt: new Date(candidate.schedule.endsAt),
              }
            : { ...candidate.schedule },
        emailNotifications:
          patch.emailNotifications === undefined
            ? current.emailNotifications
            : resolveEmailNotifications(patch.emailNotifications),
        updatedAt: new Date(),
      },
      $inc: { revision: 1 },
    },
    { returnDocument: "after" },
  );
  // The atomic predicate also detects edits/deletion after our initial read.
  if (!updated) throw new EventRevisionError();
  return updated;
}

/** Returns false for missing/foreign events; stale owned revisions throw. */
export async function deleteEvent(
  collection: Collection<EventDocument>,
  id: string,
  ownerId: string,
  expectedRevision: number,
): Promise<boolean> {
  const result = await collection.deleteOne({
    _id: new ObjectId(id),
    ownerId,
    revision: expectedRevision,
  });
  if (result.deletedCount === 1) return true;
  if (await getEvent(collection, id, ownerId)) throw new EventRevisionError();
  return false;
}
