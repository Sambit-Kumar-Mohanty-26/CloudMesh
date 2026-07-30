import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import {
  getActiveOrgIds,
  getOrgLiveStats,
  recordOrgRequestOutcome,
} from "../../src/lib/orgLiveStats.js";

const redis = new Redis(process.env.REDIS_URL!);
afterAll(() => redis.disconnect());

function orgId(): string {
  return `test-org-${randomUUID()}`;
}

describe("recordOrgRequestOutcome / getOrgLiveStats", () => {
  it("returns a zero reading for an org with no recorded requests", async () => {
    const stats = await getOrgLiveStats(redis, orgId());
    expect(stats).toEqual({ rps: 0, p99: 0, errors: 0 });
  });

  it("records a single sample and reflects it in stats", async () => {
    const org = orgId();
    await recordOrgRequestOutcome(redis, org, 120, false);

    const stats = await getOrgLiveStats(redis, org);
    expect(stats.p99).toBe(120);
    expect(stats.errors).toBe(0);
    // rps is rounded to 2 decimals for a human-readable dashboard number —
    // 1 sample in the 60s window is 1/60 rounded, not the exact fraction.
    expect(stats.rps).toBe(Number((1 / 60).toFixed(2)));
  });

  it("counts errors separately from successes", async () => {
    const org = orgId();
    await recordOrgRequestOutcome(redis, org, 100, false);
    await recordOrgRequestOutcome(redis, org, 100, true);
    await recordOrgRequestOutcome(redis, org, 100, true);

    const stats = await getOrgLiveStats(redis, org);
    expect(stats.errors).toBe(2);
  });

  it("computes p99 from real percentiles of recorded latencies", async () => {
    const org = orgId();
    for (let ms = 1; ms <= 100; ms++) {
      await recordOrgRequestOutcome(redis, org, ms, false);
    }

    const stats = await getOrgLiveStats(redis, org);
    expect(stats.p99).toBeGreaterThanOrEqual(97);
  });

  it("excludes samples older than the 60s window", async () => {
    const org = orgId();
    const now = Date.now();
    const longAgo = now - 5 * 60_000;
    await recordOrgRequestOutcome(redis, org, 999, true, longAgo);
    await recordOrgRequestOutcome(redis, org, 50, false, now);

    const stats = await getOrgLiveStats(redis, org, now);
    expect(stats.errors).toBe(0);
    expect(stats.p99).toBe(50);
  });

  it("never mixes samples between two different orgs", async () => {
    const orgA = orgId();
    const orgB = orgId();
    await recordOrgRequestOutcome(redis, orgA, 100, false);
    await recordOrgRequestOutcome(redis, orgB, 100, true);

    const statsA = await getOrgLiveStats(redis, orgA);
    const statsB = await getOrgLiveStats(redis, orgB);
    expect(statsA.errors).toBe(0);
    expect(statsB.errors).toBe(1);
  });

  describe("getActiveOrgIds", () => {
    it("includes an org after it records a sample", async () => {
      const org = orgId();
      await recordOrgRequestOutcome(redis, org, 10, false);
      const active = await getActiveOrgIds(redis);
      expect(active).toContain(org);
    });

    it("does not include an org that has never recorded a sample", async () => {
      const active = await getActiveOrgIds(redis);
      expect(active).not.toContain(orgId());
    });
  });
});
