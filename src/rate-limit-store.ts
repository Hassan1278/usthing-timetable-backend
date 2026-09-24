import type { FastifyRateLimitStore } from "@fastify/rate-limit";

/** Fixed windows with bounded LRU storage for a single API process. */
export class RateLimitMemoryStore implements FastifyRateLimitStore {
  private readonly entries = new Map<
    string,
    { count: number; expiresAt: number }
  >();
  private readonly capacity = 5000;

  incr(
    key: string,
    callback: Parameters<FastifyRateLimitStore["incr"]>[1],
    timeWindow: number,
  ): void {
    const now = Date.now();
    const previous = this.entries.get(key);
    const entry =
      previous && previous.expiresAt > now
        ? { count: previous.count + 1, expiresAt: previous.expiresAt }
        : { count: 1, expiresAt: now + timeWindow };
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > this.capacity) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    // Return a fresh snapshot. The plugin awaits this result; sharing a mutable
    // counter object would let a concurrent increment change this request's count.
    callback(null, { current: entry.count, ttl: entry.expiresAt - now });
  }

  child(): RateLimitMemoryStore {
    return new RateLimitMemoryStore();
  }
}
