import { afterAll, describe, expect, it } from "vitest";
import { slidingWindowLog } from "../src/slidingWindowLog.js";
import { createTestRedis, testIdentifier } from "./helpers.js";

const redis = createTestRedis();
afterAll(() => redis.disconnect());

describe("slidingWindowLog", () => {
  it("allows requests up to the limit", async () => {
    const id = testIdentifier();
    for (let i = 0; i < 5; i++) {
      const res = await slidingWindowLog(redis, id, { limit: 5, windowMs: 60_000 });
      expect(res.allowed).toBe(true);
    }
  });

  it("denies the request that exceeds the limit", async () => {
    const id = testIdentifier();
    for (let i = 0; i < 3; i++) {
      await slidingWindowLog(redis, id, { limit: 3, windowMs: 60_000 });
    }
    const res = await slidingWindowLog(redis, id, { limit: 3, windowMs: 60_000 });
    expect(res.allowed).toBe(false);
  });

  it("truly slides — capacity frees up as old entries age out, not at a fixed boundary", async () => {
    const id = testIdentifier();
    const config = { limit: 2, windowMs: 200 };

    expect((await slidingWindowLog(redis, id, config)).allowed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await slidingWindowLog(redis, id, config)).allowed).toBe(true);
    // Both of the above are still within the 200ms window of "now".
    expect((await slidingWindowLog(redis, id, config)).allowed).toBe(false);

    // Wait past the first request's window (120 + 100 > 200), but not the
    // second's — exactly one slot should free up, not both.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await slidingWindowLog(redis, id, config)).allowed).toBe(true);
    expect((await slidingWindowLog(redis, id, config)).allowed).toBe(false);
  });

  it("counts concurrent same-millisecond requests correctly (unique members)", async () => {
    const id = testIdentifier();
    const limit = 10;
    const attempts = 50;

    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        slidingWindowLog(redis, id, { limit, windowMs: 60_000 }),
      ),
    );

    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(limit);
  });
});
