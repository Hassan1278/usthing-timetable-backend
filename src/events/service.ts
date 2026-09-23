import { randomUUID } from "node:crypto";
import { type Collection, ObjectId } from "mongodb";
import { applyCreateEventDefaults } from "./defaults.js";
import type { EventDocument } from "./model.js";
import type { CreateEventInput } from "./schemas.js";
import { validateEvent } from "./validation.js";

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

  await collection.insertOne(event);
  return event;
}
