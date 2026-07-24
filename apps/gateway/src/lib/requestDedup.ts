import type { Redis } from "ioredis";

export interface RequestDedupOptions {
  /** Bounds how long a "leader" claim lives before it expires on its own —
   *  protects against a crashed leader wedging the key forever. */
  leaderTtlSeconds: number;
  /** How long a follower waits for the leader's result before giving up and
   *  doing the work itself instead of hanging indefinitely. */
  followerWaitMs: number;
}

// Not valid JSON (no quotes, not a number/bool/null) — safely distinguishable
// from any real JSON.stringify(result) a leader could have written.
const PROCESSING = "__DEDUP_PROCESSING__";

function dedupKey(key: string): string {
  return `dedup:${key}`;
}

function resultChannel(key: string): string {
  return `dedup_result:${key}`;
}

/**
 * Coalesces identical in-flight requests: the first caller for a given key
 * ("leader") actually runs `fn`; concurrent callers with the same key
 * ("followers") wait for and reuse its result instead of each running `fn`
 * themselves. Matches the design doc's SETNX + pub/sub sketch, with two
 * robustness additions the diagram doesn't show:
 *
 * 1. A failed leader releases the key and publishes a failure signal
 *    immediately, rather than leaving followers to wait out the full TTL.
 * 2. A follower re-checks the key immediately after subscribing (not just
 *    once, before subscribing) — closes the race window where the leader
 *    finishes and publishes between the follower's initial GET and its
 *    SUBSCRIBE, which would otherwise strand the follower until its
 *    followerWaitMs timeout for a message that already fired.
 *
 * Either way, a follower that can't get the leader's result within
 * `followerWaitMs` (timeout, leader crash, leader failure) falls back to
 * running `fn` itself — coalescing is a cost optimization, not something a
 * caller may depend on for correctness.
 */
export async function withRequestDedup<T>(
  redis: Redis,
  key: string,
  fn: () => Promise<T>,
  opts: RequestDedupOptions,
): Promise<T> {
  const rKey = dedupKey(key);
  const claimed = await redis.set(rKey, PROCESSING, "EX", opts.leaderTtlSeconds, "NX");

  if (claimed === "OK") {
    try {
      const result = await fn();
      const payload = JSON.stringify(result);
      await redis.set(rKey, payload, "EX", opts.leaderTtlSeconds);
      await redis.publish(resultChannel(key), payload);
      return result;
    } catch (err) {
      await redis.del(rKey);
      await redis.publish(resultChannel(key), JSON.stringify({ __dedupFailed: true }));
      throw err;
    }
  }

  const existing = await redis.get(rKey);
  if (existing && existing !== PROCESSING) {
    return JSON.parse(existing) as T;
  }

  return waitForLeader<T>(redis, key, opts, fn);
}

async function waitForLeader<T>(
  redis: Redis,
  key: string,
  opts: RequestDedupOptions,
  fallback: () => Promise<T>,
): Promise<T> {
  const subscriber = redis.duplicate();
  try {
    await subscriber.subscribe(resultChannel(key));

    // Close the GET-then-SUBSCRIBE race described above.
    const recheck = await redis.get(dedupKey(key));
    if (recheck && recheck !== PROCESSING) {
      return JSON.parse(recheck) as T;
    }

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("dedup follower timed out")),
        opts.followerWaitMs,
      );
      subscriber.on("message", (_channel: string, message: string) => {
        clearTimeout(timer);
        const parsed = JSON.parse(message) as T & { __dedupFailed?: boolean };
        if ((parsed as { __dedupFailed?: boolean }).__dedupFailed) {
          reject(new Error("dedup leader failed"));
        } else {
          resolve(parsed);
        }
      });
    });
  } catch {
    return fallback();
  } finally {
    await subscriber.unsubscribe(resultChannel(key)).catch(() => undefined);
    subscriber.disconnect();
  }
}
