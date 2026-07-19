import { afterAll, describe, expect, it } from "vitest";
import { slidingWindowCounter } from "../src/slidingWindowCounter.js";
import { createTestRedis, testIdentifier } from "./helpers.js";

const redis = createTestRedis();
afterAll(() => redis.disconnect());

describe("slidingWindowCounter", () => {
  it("allows requests up to the limit", async () => {
    const id = testIdentifier();
    for (let i = 0; i < 5; i++) {
      const res = await slidingWindowCounter(redis, id, { limit: 5, windowMs: 60_000 });
      expect(res.allowed).toBe(true);
    }
  });

  it("denies the request that exceeds the limit within one window", async () => {
    const id = testIdentifier();
    for (let i = 0; i < 3; i++) {
      await slidingWindowCounter(redis, id, { limit: 3, windowMs: 60_000 });
    }
    const res = await slidingWindowCounter(redis, id, { limit: 3, windowMs: 60_000 });
    expect(res.allowed).toBe(false);
  });

  it("carries weighted capacity across a window boundary instead of hard-resetting", async () => {
    // Real Date.now() sleeps can't reliably land a test exactly at a
    // window boundary (alignment depends on wall-clock, not on when the
    // test happens to start) — inject `now` explicitly instead, which
    // makes this deterministic rather than occasionally flaky.
    const id = testIdentifier();
    const windowMs = 1000;
    const config = { limit: 4, windowMs };
    const windowA = 100_000_000; // arbitrary, aligned to a windowMs boundary

    // Fill window A to its limit, 900ms in (elapsedFraction irrelevant
    // here since prev is empty for a brand-new identifier).
    for (let i = 0; i < 4; i++) {
      const res = await slidingWindowCounter(redis, id, config, windowA + 900);
      expect(res.allowed).toBe(true);
    }
    expect((await slidingWindowCounter(redis, id, config, windowA + 900)).allowed).toBe(false);

    // Exactly at the next window's boundary (elapsedFraction = 0): a
    // Fixed Window counter would allow a fresh burst of 4 right here,
    // since its counter hard-resets to a new key. Sliding Window Counter
    // must not — the previous window's full usage still weighs at 100%.
    const windowB = windowA + windowMs;
    expect((await slidingWindowCounter(redis, id, config, windowB)).allowed).toBe(false);

    // Well into window B (99% elapsed), the previous window's weight has
    // decayed to almost nothing — a fresh request should be allowed again.
    expect((await slidingWindowCounter(redis, id, config, windowB + 990)).allowed).toBe(true);
  });

  it("is atomic under real concurrency — exactly `limit` requests succeed", async () => {
    const id = testIdentifier();
    const limit = 10;
    const attempts = 50;

    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        slidingWindowCounter(redis, id, { limit, windowMs: 60_000 }),
      ),
    );

    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(limit);
  });
});
