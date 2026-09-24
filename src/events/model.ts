import type { ObjectId } from "mongodb";
import type { EventWithDefaults } from "./defaults.js";
import type { EventException } from "./exception-schema.js";
import type { ResolvedRecurrence } from "./recurrence-schema.js";

/** Fixed Hong Kong timetable; MongoDB serializes Date values as BSON dates. */
export type StoredSchedule =
  | { kind: "timed"; startsAt: Date; endsAt: Date }
  | Extract<EventWithDefaults["schedule"], { kind: "all-day" }>;

/**
 * A stored event or finite recurring series after validation and default resolution.
 * This TypeScript type does not create a MongoDB collection or runtime validator.
 */
export type EventDocument = Omit<
  EventWithDefaults,
  "schedule" | "recurrence"
> & {
  _id: ObjectId;
  recurrence?: ResolvedRecurrence;
  exceptions?: EventException[];
  /** Immutable account ID taken from the authenticated identity. */
  ownerId: string;
  schedule: StoredSchedule;
  /** Stable calendar identity preserved across ICS exports and event edits. */
  uid: string;
  /** Starts at 1; updates check and increment it atomically. */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};
