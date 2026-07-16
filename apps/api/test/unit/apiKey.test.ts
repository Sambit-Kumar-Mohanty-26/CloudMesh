import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "../../src/lib/apiKey.js";

describe("generateApiKey", () => {
  it("generates keys with the expected prefix", () => {
    const { rawKey } = generateApiKey();
    expect(rawKey.startsWith("cm_live_")).toBe(true);
  });

  it("generates a unique key on every call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(generateApiKey().rawKey);
    }
    expect(seen.size).toBe(1000);
  });

  it("keyPrefix is a stable, non-secret slice of the raw key", () => {
    const { rawKey, keyPrefix } = generateApiKey();
    expect(rawKey.startsWith(keyPrefix)).toBe(true);
    expect(keyPrefix.length).toBeLessThan(rawKey.length);
  });

  it("has enough entropy that the raw key isn't guessable from its prefix", () => {
    const { rawKey, keyPrefix } = generateApiKey();
    const secretPart = rawKey.slice(keyPrefix.length);
    expect(secretPart.length).toBeGreaterThanOrEqual(24);
  });
});

describe("hashApiKey", () => {
  it("is deterministic", () => {
    const { rawKey } = generateApiKey();
    expect(hashApiKey(rawKey)).toBe(hashApiKey(rawKey));
  });

  it("produces a 64-char hex sha256 digest", () => {
    const { rawKey } = generateApiKey();
    expect(hashApiKey(rawKey)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different keys hash to different values", () => {
    const a = generateApiKey().rawKey;
    const b = generateApiKey().rawKey;
    expect(hashApiKey(a)).not.toBe(hashApiKey(b));
  });

  it("never leaks the raw key inside the hash", () => {
    const { rawKey } = generateApiKey();
    expect(hashApiKey(rawKey)).not.toContain(rawKey);
  });
});
