import { getAdminPrisma, getAppPrisma, resetDatabase } from "@cloudmesh/db";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computePromptHash,
  flushCache,
  getCacheStats,
  lookupCache,
  recordCacheOutcome,
  storeCache,
} from "../../src/lib/semanticCache.js";

const DIMS = 1536;
const OPTS = { similarityThreshold: 0.92, ttlDays: 7 };

// Two orthonormal basis vectors — lets tests construct an embedding with an
// EXACT, known cosine similarity to another, rather than relying on real
// (unpredictable) embedding output.
function unitVector(index: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[index] = 1;
  return v;
}

/** A unit vector whose cosine similarity to `a` (also a unit vector) is
 *  exactly `cosTheta`. */
function blend(a: number[], b: number[], cosTheta: number): number[] {
  const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
  return a.map((av, i) => av * cosTheta + b[i]! * sinTheta);
}

async function createOrg(name: string): Promise<string> {
  const db = getAdminPrisma();
  const org = await db.organization.create({ data: { name } });
  return org.id;
}

describe("semantic cache", () => {
  const db = getAppPrisma();
  const A = unitVector(0);
  const B = unitVector(1);

  beforeEach(async () => {
    await resetDatabase();
  });

  it("hits on an identical embedding within the same org+model", async () => {
    const orgId = await createOrg("Cache Org");
    const hash = computePromptHash("gpt-4o", [{ role: "user", content: "explain JWT" }]);
    await storeCache(db, orgId, "gpt-4o", hash, A, "cached response");

    const result = await lookupCache(db, orgId, "gpt-4o", "different-hash", A, OPTS);
    expect(result).toBe("cached response");
  });

  it("misses when similarity is below the threshold", async () => {
    const orgId = await createOrg("Cache Org");
    await storeCache(db, orgId, "gpt-4o", "hash-a", A, "cached response");

    // Orthogonal vector -> cosine similarity 0, well under 0.92.
    const result = await lookupCache(db, orgId, "gpt-4o", "different-hash", B, OPTS);
    expect(result).toBeNull();
  });

  it("hits just above the threshold and misses just below it", async () => {
    const orgId = await createOrg("Cache Org");
    await storeCache(db, orgId, "gpt-4o", "hash-a", A, "cached response");

    const aboveThreshold = blend(A, B, 0.95);
    const belowThreshold = blend(A, B, 0.85);

    await expect(lookupCache(db, orgId, "gpt-4o", "miss-1", aboveThreshold, OPTS)).resolves.toBe(
      "cached response",
    );
    await expect(
      lookupCache(db, orgId, "gpt-4o", "miss-2", belowThreshold, OPTS),
    ).resolves.toBeNull();
  });

  it("never returns a hit for a different model, even with an identical embedding", async () => {
    const orgId = await createOrg("Cache Org");
    await storeCache(db, orgId, "gpt-4o", "hash-a", A, "gpt-4o response");

    const result = await lookupCache(db, orgId, "claude-3-5-sonnet", "hash-b", A, OPTS);
    expect(result).toBeNull();
  });

  it("never returns a hit from another org's cache, even with an identical embedding", async () => {
    const orgA = await createOrg("Org A");
    const orgB = await createOrg("Org B");
    await storeCache(db, orgA, "gpt-4o", "hash-a", A, "org A's response");

    const result = await lookupCache(db, orgB, "gpt-4o", "hash-a", A, OPTS);
    expect(result).toBeNull();
  });

  it("exact prompt-hash match short-circuits even when the embedding wouldn't match", async () => {
    const orgId = await createOrg("Cache Org");
    const hash = computePromptHash("gpt-4o", [{ role: "user", content: "explain JWT" }]);
    await storeCache(db, orgId, "gpt-4o", hash, A, "cached response");

    // Same hash, but a wildly different embedding — the exact-hash fast
    // path must still return the cached response.
    const result = await lookupCache(db, orgId, "gpt-4o", hash, B, OPTS);
    expect(result).toBe("cached response");
  });

  it("excludes entries older than the TTL window", async () => {
    const orgId = await createOrg("Cache Org");
    await storeCache(db, orgId, "gpt-4o", "hash-a", A, "stale response");

    const admin = getAdminPrisma();
    await admin.semanticCacheEntry.updateMany({
      where: { orgId },
      data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });

    const result = await lookupCache(db, orgId, "gpt-4o", "different-hash", A, {
      ...OPTS,
      ttlDays: 7,
    });
    expect(result).toBeNull();
  });

  it("flushCache with no keepModel removes every entry for the org", async () => {
    const orgId = await createOrg("Cache Org");
    await storeCache(db, orgId, "gpt-4o", "hash-a", A, "response a");
    await storeCache(db, orgId, "claude-3-5-sonnet", "hash-b", A, "response b");

    const deleted = await flushCache(db, orgId);
    expect(deleted).toBe(2);
    expect(await lookupCache(db, orgId, "gpt-4o", "hash-a", A, OPTS)).toBeNull();
    expect(await lookupCache(db, orgId, "claude-3-5-sonnet", "hash-b", A, OPTS)).toBeNull();
  });

  it("flushCache with keepModel preserves only that model's entries", async () => {
    const orgId = await createOrg("Cache Org");
    await storeCache(db, orgId, "gpt-4o", "hash-a", A, "old model response");
    await storeCache(db, orgId, "gpt-4o-2", "hash-b", A, "current model response");

    const deleted = await flushCache(db, orgId, "gpt-4o-2");
    expect(deleted).toBe(1);
    expect(await lookupCache(db, orgId, "gpt-4o", "hash-a", A, OPTS)).toBeNull();
    expect(await lookupCache(db, orgId, "gpt-4o-2", "hash-b", A, OPTS)).toBe(
      "current model response",
    );
  });

  it("flushCache never touches another org's entries", async () => {
    const orgA = await createOrg("Org A");
    const orgB = await createOrg("Org B");
    await storeCache(db, orgA, "gpt-4o", "hash-a", A, "org A's response");
    await storeCache(db, orgB, "gpt-4o", "hash-b", A, "org B's response");

    await flushCache(db, orgA);
    expect(await lookupCache(db, orgB, "gpt-4o", "hash-b", A, OPTS)).toBe("org B's response");
  });
});

describe("computePromptHash", () => {
  it("is stable for the same model + messages", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    expect(computePromptHash("gpt-4o", messages)).toBe(computePromptHash("gpt-4o", messages));
  });

  it("differs when the model differs", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    expect(computePromptHash("gpt-4o", messages)).not.toBe(
      computePromptHash("claude-3-5-sonnet", messages),
    );
  });

  it("differs when message history differs", () => {
    const a = [{ role: "user" as const, content: "hi" }];
    const b = [
      { role: "system" as const, content: "be nice" },
      { role: "user" as const, content: "hi" },
    ];
    expect(computePromptHash("gpt-4o", a)).not.toBe(computePromptHash("gpt-4o", b));
  });
});

describe("cache stats", () => {
  const redis = new Redis(process.env.REDIS_URL!);

  afterAll(() => redis.disconnect());
  afterEach(async () => {
    await redis.flushdb();
  });

  it("counts hits and misses per org, independently of other orgs", async () => {
    const orgId = "stats-org-a";
    const otherOrgId = "stats-org-b";

    await recordCacheOutcome(redis, orgId, "hit");
    await recordCacheOutcome(redis, orgId, "hit");
    await recordCacheOutcome(redis, orgId, "miss");
    await recordCacheOutcome(redis, otherOrgId, "miss");

    expect(await getCacheStats(redis, orgId)).toEqual({ hits: 2, misses: 1 });
    expect(await getCacheStats(redis, otherOrgId)).toEqual({ hits: 0, misses: 1 });
  });

  it("returns zeros for an org with no recorded outcomes", async () => {
    expect(await getCacheStats(redis, "never-seen-org")).toEqual({ hits: 0, misses: 0 });
  });
});
