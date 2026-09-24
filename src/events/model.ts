import type { ObjectId } from "mongodb";
import type { EventWithDefaults } from "./defaults.js";

/** Fixed Hong Kong timetable; MongoDB serializes Date values as BSON dates. */
export type StoredSchedule =
  | { kind: "timed"; startsAt: Date; endsAt: Date }
  | Extract<EventWithDefaults["schedule"], { kind: "all-day" }>;

/**
 * A stored, non-recurring event after validation and default resolution.
 * This TypeScript type does not create a MongoDB collection or runtime validator.
 */
export type EventDocument = Omit<EventWithDefaults, "schedule"> & {
  _id: ObjectId;
  /** Immutable account ID taken from the authenticated identity. */
  ownerId: string;
  schedule: StoredSchedule;
  /** Stable calendar identity for future ICS import/export. */
  uid: string;
  /** Starts at 1; updates check and increment it atomically. */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};
