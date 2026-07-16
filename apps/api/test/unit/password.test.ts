import { describe, expect, it } from "vitest";
import {
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
  verifyPasswordConstantTime,
} from "../../src/lib/password.js";

describe("validatePasswordStrength", () => {
  it("rejects passwords under 8 characters", () => {
    expect(validatePasswordStrength("a".repeat(7))).not.toBeNull();
  });

  it("accepts an 8-character password", () => {
    expect(validatePasswordStrength("a".repeat(8))).toBeNull();
  });

  it("accepts a 72-character password", () => {
    expect(validatePasswordStrength("a".repeat(72))).toBeNull();
  });

  it("rejects a 73-character password (beyond bcrypt's 72-byte limit)", () => {
    expect(validatePasswordStrength("a".repeat(73))).not.toBeNull();
  });

  it("rejects an empty password", () => {
    expect(validatePasswordStrength("")).not.toBeNull();
  });
});

describe("hashPassword / verifyPassword", () => {
  it("round-trips correctly", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password entirely", hash)).toBe(false);
  });

  it("produces a different hash each time (random salt)", async () => {
    const a = await hashPassword("same-input-password");
    const b = await hashPassword("same-input-password");
    expect(a).not.toBe(b);
  });

  it("never stores the password itself in the hash", async () => {
    const hash = await hashPassword("super-secret-value-12345");
    expect(hash).not.toContain("super-secret-value-12345");
  });
});

describe("verifyPasswordConstantTime", () => {
  it("returns true for a matching password", async () => {
    const hash = await hashPassword("matches-this-one");
    expect(await verifyPasswordConstantTime("matches-this-one", hash)).toBe(true);
  });

  it("returns false for a non-matching password", async () => {
    const hash = await hashPassword("matches-this-one");
    expect(await verifyPasswordConstantTime("does-not-match", hash)).toBe(false);
  });

  it("returns false (not throws) when hash is null — the 'no such user' path", async () => {
    await expect(verifyPasswordConstantTime("anything", null)).resolves.toBe(false);
  });
});
