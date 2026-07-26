import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { getProviderStats, recordProviderOutcome } from "../../src/lib/providerStats.js";

const redis = new Redis(process.env.REDIS_URL!);
afterAll(() => redis.disconnect());

function providerName(): string {
  return `test-provider-${randomUUID()}`;
}

describe("recordProviderOutcome / getProviderStats", () => {
  it("returns a zero-sample reading for a provider with no recorded calls", async () => {
    const stats = await getProviderStats(redis, providerName());
    expect(stats).toEqual({ sampleCount: 0, p50Ms: 0, p99Ms: 0, successRate: 0, rpmCurrent: 0 });
  });

  it("records a single sample and reflects it in stats", async () => {
    const provider = providerName();
    await recordProviderOutcome(redis, provider, 250, true);

    const stats = await getProviderStats(redis, provider);
    expect(stats.sampleCount).toBe(1);
    expect(stats.p50Ms).toBe(250);
    expect(stats.p99Ms).toBe(250);
    expect(stats.successRate).toBe(1);
    expect(stats.rpmCurrent).toBe(1);
  });

  it("computes successRate as the fraction of successful samples", async () => {
    const provider = providerName();
    await recordProviderOutcome(redis, provider, 100, true);
    await recordProviderOutcome(redis, provider, 100, true);
    await recordProviderOutcome(redis, provider, 100, false);
    await recordProviderOutcome(redis, provider, 100, false);

    const stats = await getProviderStats(redis, provider);
    expect(stats.sampleCount).toBe(4);
    expect(stats.successRate).toBe(0.5);
  });

  it("computes p50/p99 from real percentiles of recorded latencies", async () => {
    const provider = providerName();
    // 1..100 ms — p50 should land near the middle, p99 near the top.
    for (let ms = 1; ms <= 100; ms++) {
      await recordProviderOutcome(redis, provider, ms, true);
    }

    const stats = await getProviderStats(redis, provider);
    expect(stats.sampleCount).toBe(100);
    expect(stats.p50Ms).toBeGreaterThanOrEqual(48);
    expect(stats.p50Ms).toBeLessThanOrEqual(52);
    expect(stats.p99Ms).toBeGreaterThanOrEqual(97);
  });

  it("two calls in the same millisecond with identical latency are both recorded, not collapsed", async () => {
    const provider = providerName();
    const now = Date.now();
    await Promise.all([
      recordProviderOutcome(redis, provider, 50, true, now),
      recordProviderOutcome(redis, provider, 50, true, now),
    ]);

    const stats = await getProviderStats(redis, provider, now);
    expect(stats.sampleCount).toBe(2);
  });

  it("excludes samples older than the stats window", async () => {
    const provider = providerName();
    const now = Date.now();
    const longAgo = now - 10 * 60_000; // 10 minutes ago — outside the 5-minute window
    await recordProviderOutcome(redis, provider, 999, false, longAgo);
    await recordProviderOutcome(redis, provider, 100, true, now);

    const stats = await getProviderStats(redis, provider, now);
    expect(stats.sampleCount).toBe(1);
    expect(stats.p50Ms).toBe(100);
    expect(stats.successRate).toBe(1);
  });

  it("rpmCurrent only counts samples within the last 60s, even though the stats window is wider", async () => {
    const provider = providerName();
    const now = Date.now();
    const twoMinutesAgo = now - 2 * 60_000; // within the 5-min stats window, outside the 60s rpm window
    await recordProviderOutcome(redis, provider, 100, true, twoMinutesAgo);
    await recordProviderOutcome(redis, provider, 100, true, now);
    await recordProviderOutcome(redis, provider, 100, true, now);

    const stats = await getProviderStats(redis, provider, now);
    expect(stats.sampleCount).toBe(3); // all 3 count toward the wider stats window
    expect(stats.rpmCurrent).toBe(2); // only the two "now" samples count toward rpm
  });

  it("never mixes samples between two different providers", async () => {
    const providerA = providerName();
    const providerB = providerName();
    await recordProviderOutcome(redis, providerA, 100, true);
    await recordProviderOutcome(redis, providerB, 999, false);

    const statsA = await getProviderStats(redis, providerA);
    const statsB = await getProviderStats(redis, providerB);
    expect(statsA.sampleCount).toBe(1);
    expect(statsA.successRate).toBe(1);
    expect(statsB.sampleCount).toBe(1);
    expect(statsB.successRate).toBe(0);
  });
});
