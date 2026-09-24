import type { Collection } from "mongodb";
import type { EventDocument } from "../domain/model.js";

const pendingWrites = new WeakMap<
  Collection<EventDocument>,
  Map<string, Promise<void>>
>();

/** Serialize one owner's writes in this API process, including check-and-save. */
export async function withEventWriteLock<T>(
  collection: Collection<EventDocument>,
  ownerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let owners = pendingWrites.get(collection);
  if (!owners) {
    owners = new Map();
    pendingWrites.set(collection, owners);
  }
  const previous = owners.get(ownerId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  owners.set(ownerId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (owners.get(ownerId) === current) owners.delete(ownerId);
  }
}
