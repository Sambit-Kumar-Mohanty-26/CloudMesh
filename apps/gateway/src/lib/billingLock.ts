import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

export interface DistributedLockOptions {
  /** Lock TTL — protects against a crashed holder wedging the lock forever. */
  ttlMs: number;
  /** How many additional attempts after the first, on contention. */
  retries: number;
  retryDelayMs: number;
  /** Injectable for deterministic tests — defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export class LockAcquisitionError extends Error {
  constructor(public readonly lockKey: string) {
    super(`Could not acquire lock "${lockKey}" after retrying`);
    this.name = "LockAcquisitionError";
  }
}

function lockKeyFor(name: string): string {
  return `billing:lock:${name}`;
}

// Compare-and-delete: only releases the lock if it still holds OUR token.
// Without this, a slow holder whose TTL expired mid-`fn` could delete a
// DIFFERENT caller's lock that acquired it in the meantime — a classic
// unsafe-Redis-lock bug, not a hypothetical one.
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Redis SETNX-based distributed lock (design doc: `billing:lock:{org_id}:
 * {period}`, "acquired -> read budget, write usage, release; not acquired ->
 * retry 3x with 50ms backoff"). Prevents two concurrent requests both
 * reading a not-yet-updated budget total and both passing a check they
 * shouldn't both pass.
 *
 * Throws `LockAcquisitionError` if every attempt is contended — callers
 * decide how to surface that (a 503, in the billing service's case).
 */
export async function withDistributedLock<T>(
  redis: Redis,
  name: string,
  fn: () => Promise<T>,
  opts: DistributedLockOptions,
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const key = lockKeyFor(name);
  const token = randomUUID();

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    const acquired = await redis.set(key, token, "PX", opts.ttlMs, "NX");
    if (acquired === "OK") {
      try {
        return await fn();
      } finally {
        await redis.eval(RELEASE_SCRIPT, 1, key, token);
      }
    }
    if (attempt < opts.retries) {
      await sleep(opts.retryDelayMs);
    }
  }

  throw new LockAcquisitionError(key);
}
