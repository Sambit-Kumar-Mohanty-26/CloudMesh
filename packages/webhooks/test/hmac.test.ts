import { describe, expect, it } from "vitest";
import { generateWebhookSecret, signWebhookPayload, verifyWebhookSignature } from "../src/hmac.js";

describe("generateWebhookSecret", () => {
  it("generates a high-entropy secret with a recognizable prefix", () => {
    const secret = generateWebhookSecret();
    expect(secret.startsWith("whsec_")).toBe(true);
    expect(secret.length).toBeGreaterThan(32);
  });

  it("never generates the same secret twice", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateWebhookSecret());
    expect(seen.size).toBe(500);
  });
});

describe("signWebhookPayload / verifyWebhookSignature", () => {
  const secret = "whsec_test_secret";
  const payload = JSON.stringify({ event: "job.completed", data: { jobId: "abc" } });

  it("a signature verifies against the exact payload it was computed from", () => {
    const sig = signWebhookPayload(payload, secret);
    expect(verifyWebhookSignature(payload, secret, sig)).toBe(true);
  });

  it("rejects a signature computed with a different secret", () => {
    const sig = signWebhookPayload(payload, "whsec_wrong_secret");
    expect(verifyWebhookSignature(payload, secret, sig)).toBe(false);
  });

  it("rejects a signature if even one byte of the payload changed", () => {
    const sig = signWebhookPayload(payload, secret);
    const tampered = payload.replace("abc", "xyz");
    expect(verifyWebhookSignature(tampered, secret, sig)).toBe(false);
  });

  it("rejects re-serialized JSON that is semantically equal but byte-different", () => {
    // The exact scenario the module comment warns about: same data,
    // different key order -> different bytes -> different signature.
    const original = JSON.stringify({ a: 1, b: 2 });
    const reserialized = JSON.stringify({ b: 2, a: 1 });
    const sig = signWebhookPayload(original, secret);
    expect(verifyWebhookSignature(reserialized, secret, sig)).toBe(false);
  });

  it("rejects a malformed (non-hex) signature without throwing", () => {
    expect(verifyWebhookSignature(payload, secret, "not-hex-at-all!!")).toBe(false);
    expect(verifyWebhookSignature(payload, secret, "")).toBe(false);
  });

  it("rejects a signature of the wrong length rather than crashing timingSafeEqual", () => {
    expect(verifyWebhookSignature(payload, secret, "deadbeef")).toBe(false);
  });

  it("is deterministic — the same payload and secret always produce the same signature", () => {
    expect(signWebhookPayload(payload, secret)).toBe(signWebhookPayload(payload, secret));
  });
});
