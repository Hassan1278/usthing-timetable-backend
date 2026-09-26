import { createHash } from "node:crypto";
import type { Collection } from "mongodb";

export type RateCounter = {
  _id: string;
  current: number;
  expiresAt: Date;
  observedAt: Date;
};

/** Atomic fixed windows shared across replicas. TTL cleanup never evicts live keys. */
export class RateLimitMongoStore {
  constructor(private readonly collection: Collection<RateCounter>) {}

  async consume(scope: string, key: string, timeWindow: number, max: number) {
    const id = createHash("sha256")
      .update(JSON.stringify([scope, key]))
      .digest("hex");
    const live = { $gt: [{ $ifNull: ["$expiresAt", new Date(0)] }, "$$NOW"] };
    const update = () =>
      this.collection.findOneAndUpdate(
        { _id: id },
        [
          {
            $set: {
              current: {
                $cond: [
                  live,
                  { $min: [{ $add: ["$current", 1] }, max + 1] },
                  1,
                ],
              },
              expiresAt: {
                $cond: [live, "$expiresAt", { $add: ["$$NOW", timeWindow] }],
              },
              observedAt: "$$NOW",
            },
          },
        ],
        { upsert: true, returnDocument: "after", timeoutMS: 5000 },
      );
    let result: RateCounter | null;
    try {
      result = await update();
    } catch (error) {
      // Simultaneous first requests can both try to insert the unique key.
      if ((error as { code?: number }).code !== 11000) throw error;
      result = await update();
    }
    if (!result) throw new Error("Rate counter unavailable.");
    return {
      allowed: result.current <= max,
      remaining: Math.max(0, max - result.current),
      retryAfter: Math.max(
        1,
        Math.ceil(
          (result.expiresAt.getTime() - result.observedAt.getTime()) / 1000,
        ),
      ),
    };
  }
}
