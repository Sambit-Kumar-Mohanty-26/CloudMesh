import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { withRequestDedup } from "../../src/lib/requestDedup.js";

const redis = new Redis(process.env.REDIS_URL!);
afterAll(() => redis.disconnect());

const OPTS = { leaderTtlSeconds: 30, followerWaitMs: 2000 };

function key(): string {
  return `test-dedup-${randomUUID()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withRequestDedup", () => {
  it("coalesces concurrent identical requests into a single execution of fn", async () => {
    const k = key();
    let calls = 0;
    const fn = async () => {
      calls++;
      await sleep(100);
      return { value: "result", callNumber: calls };
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => withRequestDedup(redis, k, fn, OPTS)),
    );

    expect(calls).toBe(1);
    expect(results.every((r) => r.value === "result")).toBe(true);
    // Every caller got the SAME execution's result, not their own.
    expect(new Set(results.map((r) => r.callNumber)).size).toBe(1);
  });

  it("runs fn independently for different keys", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return calls;
    };

    await Promise.all([
      withRequestDedup(redis, key(), fn, OPTS),
      withRequestDedup(redis, key(), fn, OPTS),
    ]);

    expect(calls).toBe(2);
  });

  it("a caller arriving after the leader already finished gets the cached result without re-running fn", async () => {
    const k = key();
    let calls = 0;
    const fn = async () => {
      calls++;
      return "first result";
    };

    await withRequestDedup(redis, k, fn, OPTS);
    const second = await withRequestDedup(redis, k, fn, OPTS);

    expect(calls).toBe(1);
    expect(second).toBe("first result");
  });

  it("propagates the leader's error to the leader's own caller", async () => {
    const k = key();
    await expect(
      withRequestDedup(
        redis,
        k,
        async () => {
          throw new Error("provider exploded");
        },
        OPTS,
      ),
    ).rejects.toThrow("provider exploded");
  });

  it("a failed leader releases the key immediately so a follower falls back to running fn itself, not hanging the full timeout", async () => {
    const k = key();
    let leaderCalls = 0;
    let followerCalls = 0;

    const leaderPromise = withRequestDedup(
      redis,
      k,
      async () => {
        leaderCalls++;
        await sleep(50);
        throw new Error("leader failed");
      },
      OPTS,
    );
    // Attach the rejection assertion immediately (same tick) so Node never
    // sees leaderPromise as unhandled while the follower below awaits.
    const leaderAssertion = expect(leaderPromise).rejects.toThrow("leader failed");

    // Give the leader a moment to claim the key, then start a follower.
    await sleep(10);
    const start = Date.now();
    const followerResult = await withRequestDedup(
      redis,
      k,
      async () => {
        followerCalls++;
        return "follower's own result";
      },
      OPTS,
    );
    const elapsed = Date.now() - start;

    await leaderAssertion;
    expect(leaderCalls).toBe(1);
    expect(followerCalls).toBe(1);
    expect(followerResult).toBe("follower's own result");
    // Must resolve promptly on the leader's failure signal, not wait out
    // followerWaitMs (2000ms in OPTS).
    expect(elapsed).toBeLessThan(1000);
  });

  it("a follower falls back to running fn itself if it never hears from a leader (timeout)", async () => {
    const k = key();
    // Simulate a wedged/crashed leader: claim the key but never finish or
    // publish anything.
    await redis.set(`dedup:${k}`, "__DEDUP_PROCESSING__", "EX", 30, "NX");

    let followerCalls = 0;
    const start = Date.now();
    const result = await withRequestDedup(
      redis,
      k,
      async () => {
        followerCalls++;
        return "fallback result";
      },
      { leaderTtlSeconds: 30, followerWaitMs: 200 },
    );
    const elapsed = Date.now() - start;

    expect(followerCalls).toBe(1);
    expect(result).toBe("fallback result");
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });
});
