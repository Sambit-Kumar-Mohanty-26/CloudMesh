import { afterAll, describe, expect, it } from "vitest";
import { fixedWindow } from "../src/fixedWindow.js";
import { createTestRedis, testIdentifier } from "./helpers.js";

const redis = createTestRedis();
afterAll(() => redis.disconnect());

describe("fixedWindow", () => {
  it("allows requests up to the limit", async () => {
    const id = testIdentifier();
    for (let i = 0; i < 5; i++) {
      const res = await fixedWindow(redis, id, { limit: 5, windowMs: 60_000 });
      expect(res.allowed).toBe(true);
    }
  });

  it("denies the request that exceeds the limit", async () => {
    const id = testIdentifier();
    for (let i = 0; i < 3; i++) {
      await fixedWindow(redis, id, { limit: 3, windowMs: 60_000 });
    }
    const res = await fixedWindow(redis, id, { limit: 3, windowMs: 60_000 });
    expect(res.allowed).toBe(false);
    expect(res.remaining).toBe(0);
  });

  it("resets after the window passes", async () => {
    const id = testIdentifier();
    const config = { limit: 1, windowMs: 150 };
    const first = await fixedWindow(redis, id, config);
    expect(first.allowed).toBe(true);
    const second = await fixedWindow(redis, id, config);
    expect(second.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const third = await fixedWindow(redis, id, config);
    expect(third.allowed).toBe(true);
  });

  it("is atomic under real concurrency — exactly `limit` requests succeed, never more", async () => {
    const id = testIdentifier();
    const limit = 10;
    const attempts = 50;

    const results = await Promise.all(
      Array.from({ length: attempts }, () => fixedWindow(redis, id, { limit, windowMs: 60_000 })),
    );

    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(limit);
  });
});
