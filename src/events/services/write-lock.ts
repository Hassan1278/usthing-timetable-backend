import type { ClientSession, Collection, MongoClient } from "mongodb";
import type { EventDocument } from "../domain/model.js";

const clients = new WeakMap<Collection<EventDocument>, MongoClient>();
export function registerEventTransactions(
  collection: Collection<EventDocument>,
  client: MongoClient,
) {
  clients.set(collection, client);
}

/** All API replicas write the same owner record before checking event conflicts.
 * MongoDB retries conflicting transactions with a new snapshot. The coordination
 * write and event mutation commit together, with no expiring application lease.
 */
export async function withEventWriteLock<T>(
  collection: Collection<EventDocument>,
  ownerId: string,
  operation: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const client = clients.get(collection);
  if (!client) throw new Error("Event transaction client is not registered.");
  const owners = client
    .db(collection.dbName)
    .collection<{ _id: string; revision: number }>("event_write_owners");
  // Initialize outside the transaction: concurrent first writes may race here.
  try {
    await owners.updateOne(
      { _id: ownerId },
      { $setOnInsert: { revision: 0 } },
      { upsert: true },
    );
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  const session = client.startSession();
  try {
    return await session.withTransaction(
      async () => {
        await owners.updateOne(
          { _id: ownerId },
          { $inc: { revision: 1 } },
          { session },
        );
        return operation(session);
      },
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        maxCommitTimeMS: 5000,
      },
    );
  } finally {
    await session.endSession();
  }
}
