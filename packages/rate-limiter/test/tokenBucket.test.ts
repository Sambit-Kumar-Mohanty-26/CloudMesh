import { afterAll, describe, expect, it } from "vitest";
import { tokenBucket } from "../src/tokenBucket.js";
import { createTestRedis, testIdentifier } from "./helpers.js";

const redis = createTestRedis();
afterAll(() => redis.disconnect());

describe("tokenBucket", () => {
  it("allows a burst up to capacity, then denies", async () => {
    const id = testIdentifier();
    const config = { capacity: 5, refillPerSecond: 1 };
    const now = 1_000_000;

    for (let i = 0; i < 5; i++) {
      const res = await tokenBucket(redis, id, config, now);
      expect(res.allowed).toBe(true);
    }
    const res = await tokenBucket(redis, id, config, now);
    expect(res.allowed).toBe(false);
    expect(res.remaining).toBe(0);
  });

  it("refills deterministically over injected time, never exceeding capacity", async () => {
    const id = testIdentifier();
    const config = { capacity: 5, refillPerSecond: 2 }; // 1 token every 500ms
    const start = 1_000_000;

    for (let i = 0; i < 5; i++) {
      await tokenBucket(redis, id, config, start);
    }
    expect((await tokenBucket(redis, id, config, start)).allowed).toBe(false);

    // 500ms later: exactly 1 token should have regenerated.
    expect((await tokenBucket(redis, id, config, start + 500)).allowed).toBe(true);
    expect((await tokenBucket(redis, id, config, start + 500)).allowed).toBe(false);

    // A very long gap must cap at `capacity`, not accrue indefinitely —
    // request 5, expect the 6th (in this new burst) to fail immediately.
    const farFuture = start + 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect((await tokenBucket(redis, id, config, farFuture)).allowed).toBe(true);
    }
    expect((await tokenBucket(redis, id, config, farFuture)).allowed).toBe(false);
  });

  it("works against real elapsed wall-clock time, not just injected values", async () => {
    const id = testIdentifier();
    const config = { capacity: 1, refillPerSecond: 10 }; // full refill in 100ms

    expect((await tokenBucket(redis, id, config)).allowed).toBe(true);
    expect((await tokenBucket(redis, id, config)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect((await tokenBucket(redis, id, config)).allowed).toBe(true);
  });

  it("is atomic under real concurrency — exactly `capacity` requests succeed with no elapsed time to refill", async () => {
    const id = testIdentifier();
    const capacity = 10;
    const attempts = 50;
    const now = 2_000_000; // same instant for every call — no refill window

    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        tokenBucket(redis, id, { capacity, refillPerSecond: 1 }, now),
      ),
    );

    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(capacity);
  });

  it("resetAt reflects how long until enough tokens accrue for the next request", async () => {
    const id = testIdentifier();
    const config = { capacity: 1, refillPerSecond: 2 }; // 500ms per token
    const now = 1_000_000;

    await tokenBucket(redis, id, config, now); // spend the only token
    const denied = await tokenBucket(redis, id, config, now);
    expect(denied.allowed).toBe(false);
    expect(denied.resetAt).toBeCloseTo(now + 500, -1);
  });
});
