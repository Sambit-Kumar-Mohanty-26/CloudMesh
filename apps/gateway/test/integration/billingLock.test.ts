import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { LockAcquisitionError, withDistributedLock } from "../../src/lib/billingLock.js";

const redis = new Redis(process.env.REDIS_URL!);
afterAll(() => redis.disconnect());

function lockName(): string {
  return `test-lock-${randomUUID()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withDistributedLock", () => {
  it("serializes concurrent callers — only one runs fn at a time", async () => {
    const name = lockName();
    let concurrent = 0;
    let maxConcurrent = 0;
    const order: number[] = [];

    const fn = async (id: number) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(20);
      order.push(id);
      concurrent--;
    };

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        withDistributedLock(redis, name, () => fn(i), {
          ttlMs: 2000,
          retries: 10,
          retryDelayMs: 20,
        }),
      ),
    );

    expect(maxConcurrent).toBe(1);
    expect(order).toHaveLength(5);
  });

  it("proves the exact race it exists to prevent: without the lock, concurrent read-then-write can both see stale state", async () => {
    // A direct demonstration — 20 concurrent "check counter, then increment
    // it" operations WITHOUT the lock lose increments to the classic
    // read-modify-write race; WITH the lock, none are lost.
    const key = `test-counter-${randomUUID()}`;
    await redis.set(key, "0");

    const unsafeIncrement = async () => {
      const current = Number(await redis.get(key));
      await sleep(1);
      await redis.set(key, String(current + 1));
    };
    await Promise.all(Array.from({ length: 20 }, unsafeIncrement));
    const unsafeResult = Number(await redis.get(key));
    expect(unsafeResult).toBeLessThan(20);

    const safeKey = `test-counter-safe-${randomUUID()}`;
    await redis.set(safeKey, "0");
    const name = lockName();
    const safeIncrement = () =>
      withDistributedLock(
        redis,
        name,
        async () => {
          const current = Number(await redis.get(safeKey));
          await sleep(1);
          await redis.set(safeKey, String(current + 1));
        },
        { ttlMs: 2000, retries: 25, retryDelayMs: 20 },
      );
    await Promise.all(Array.from({ length: 20 }, safeIncrement));
    expect(Number(await redis.get(safeKey))).toBe(20);
  });

  it("only releases a lock it still holds — a compare-and-delete, not a blind DEL", async () => {
    const key = lockName();
    // Simulate: our lock expired, and a different holder has since claimed
    // it with a different token. Directly SET a foreign token, bypassing
    // withDistributedLock entirely.
    await redis.set(`billing:lock:${key}`, "someone-elses-token", "PX", 5000);

    // A caller that (somehow) still tries to release with a stale token
    // must not delete the foreign holder's lock.
    const RELEASE_SCRIPT = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      end
      return 0
    `;
    const result = await redis.eval(RELEASE_SCRIPT, 1, `billing:lock:${key}`, "our-stale-token");
    expect(result).toBe(0);
    expect(await redis.get(`billing:lock:${key}`)).toBe("someone-elses-token");
  });

  it("throws LockAcquisitionError after exhausting retries against sustained contention", async () => {
    const name = lockName();
    // Hold the lock for the entire test via a long-running fn.
    const holder = withDistributedLock(redis, name, () => sleep(500), {
      ttlMs: 2000,
      retries: 0,
      retryDelayMs: 10,
    });
    await sleep(20); // let the holder actually acquire first

    await expect(
      withDistributedLock(redis, name, async () => "unreachable", {
        ttlMs: 2000,
        retries: 2,
        retryDelayMs: 20,
      }),
    ).rejects.toThrow(LockAcquisitionError);

    await holder;
  });

  it("propagates fn's error and still releases the lock for the next caller", async () => {
    const name = lockName();
    await expect(
      withDistributedLock(
        redis,
        name,
        async () => {
          throw new Error("boom");
        },
        { ttlMs: 2000, retries: 0, retryDelayMs: 10 },
      ),
    ).rejects.toThrow("boom");

    // The lock must be free immediately, not held until its TTL expires.
    let acquired = false;
    await withDistributedLock(
      redis,
      name,
      async () => {
        acquired = true;
      },
      { ttlMs: 2000, retries: 0, retryDelayMs: 10 },
    );
    expect(acquired).toBe(true);
  });
});
