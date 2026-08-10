import { beforeEach, describe, expect, it, vi } from "vitest";

// Same stub as apiClient.test.ts — "server-only" is one of Next's internal
// bundler aliases, not a real installed package, so plain vitest can't
// resolve the bare import (see CLAUDE.md's Phase 13 notes).
vi.mock("server-only", () => ({}));

const { encryptSession, decryptSession } = await import("./sessionCrypto");

const SECRET = "test-session-secret-at-least-32-characters-long";
const OTHER_SECRET = "a-completely-different-secret-also-32-chars-long";

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
});

describe("session cookie encryption", () => {
  it("round-trips a session payload unchanged", () => {
    const payload = JSON.stringify({
      accessToken: "eyJhbGciOi.fake.token",
      refreshToken: "refresh-abc-123",
      user: { id: "u1", email: "a@b.com", role: "OWNER", orgId: "o1" },
    });

    expect(decryptSession(encryptSession(payload))).toBe(payload);
  });

  it("never leaks the plaintext into the token", () => {
    const token = encryptSession(JSON.stringify({ refreshToken: "SUPER_SECRET_REFRESH" }));

    expect(token).not.toContain("SUPER_SECRET_REFRESH");
    // Also not recoverable by naive base64 decoding of any segment.
    for (const part of token.split(".")) {
      expect(Buffer.from(part, "base64url").toString("utf8")).not.toContain("SUPER_SECRET_REFRESH");
    }
  });

  it("produces a different ciphertext each time (random IV, no ECB-style leakage)", () => {
    const payload = JSON.stringify({ same: "input" });
    const a = encryptSession(payload);
    const b = encryptSession(payload);

    expect(a).not.toBe(b);
    // Both still decrypt to the same thing.
    expect(decryptSession(a)).toBe(decryptSession(b));
  });

  describe("rejects tampered input rather than trusting it", () => {
    it("rejects a flipped byte in the ciphertext (GCM auth tag catches it)", () => {
      const token = encryptSession(JSON.stringify({ role: "MEMBER" }));
      const [v, iv, tag, ct] = token.split(".");

      const bytes = Buffer.from(ct, "base64url");
      bytes[0] ^= 0xff;
      const tampered = [v, iv, tag, bytes.toString("base64url")].join(".");

      expect(decryptSession(tampered)).toBeUndefined();
    });

    it("rejects a forged auth tag", () => {
      const token = encryptSession(JSON.stringify({ role: "MEMBER" }));
      const [v, iv, , ct] = token.split(".");
      const forged = [v, iv, Buffer.alloc(16, 0x41).toString("base64url"), ct].join(".");

      expect(decryptSession(forged)).toBeUndefined();
    });

    it("rejects a token encrypted under a different secret", () => {
      const token = encryptSession(JSON.stringify({ user: "victim" }));

      process.env.SESSION_SECRET = OTHER_SECRET;
      expect(decryptSession(token)).toBeUndefined();
    });

    it("rejects a swapped IV (decryption yields garbage, tag fails)", () => {
      const token = encryptSession(JSON.stringify({ a: 1 }));
      const [v, , tag, ct] = token.split(".");
      const swapped = [v, Buffer.alloc(12, 0x00).toString("base64url"), tag, ct].join(".");

      expect(decryptSession(swapped)).toBeUndefined();
    });

    it("rejects an unknown version prefix", () => {
      const token = encryptSession(JSON.stringify({ a: 1 }));
      const [, iv, tag, ct] = token.split(".");

      expect(decryptSession(["v2", iv, tag, ct].join("."))).toBeUndefined();
      expect(decryptSession(["", iv, tag, ct].join("."))).toBeUndefined();
    });

    it.each([
      ["empty string", ""],
      ["plain text", "not-a-token"],
      ["plaintext JSON (the pre-encryption format)", '{"accessToken":"x"}'],
      ["too few segments", "v1.aaa.bbb"],
      ["too many segments", "v1.aaa.bbb.ccc.ddd"],
      ["non-base64 segments", "v1.!!!.???.***"],
      ["wrong-length IV", "v1.YWJj.YWJjZGVmZ2hpamtsbW5vcA.YWJj"],
    ])("returns undefined for %s rather than throwing", (_label, input) => {
      expect(() => decryptSession(input)).not.toThrow();
      expect(decryptSession(input)).toBeUndefined();
    });
  });

  describe("secret configuration", () => {
    it("refuses to encrypt without a secret", () => {
      delete process.env.SESSION_SECRET;
      expect(() => encryptSession("x")).toThrow(/SESSION_SECRET/);
    });

    it("refuses a secret shorter than 32 characters", () => {
      process.env.SESSION_SECRET = "too-short";
      expect(() => encryptSession("x")).toThrow(/at least 32 characters/);
    });

    it("does not echo the secret in the thrown message", () => {
      process.env.SESSION_SECRET = "short-but-recognisable-secret";
      try {
        encryptSession("x");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect((err as Error).message).not.toContain("short-but-recognisable-secret");
      }
    });
  });
});
