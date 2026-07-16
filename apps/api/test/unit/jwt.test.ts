import jsonwebtoken from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvalidTokenError,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from "../../src/lib/jwt.js";

const TEST_SECRET = process.env.JWT_SECRET!;

describe("access token sign/verify", () => {
  it("round-trips a valid payload", () => {
    const token = signAccessToken({ sub: "user-1", orgId: "org-1", role: "OWNER" });
    const payload = verifyAccessToken(token);
    expect(payload).toMatchObject({ sub: "user-1", orgId: "org-1", role: "OWNER" });
  });

  it("rejects a token signed with a different secret", () => {
    const forged = jsonwebtoken.sign(
      { sub: "user-1", orgId: "org-1", role: "OWNER" },
      "attacker-controlled-secret-that-is-long-enough",
      { algorithm: "HS256", expiresIn: "15m" },
    );
    expect(() => verifyAccessToken(forged)).toThrow(InvalidTokenError);
  });

  it("rejects a tampered payload (signature no longer matches)", () => {
    const token = signAccessToken({ sub: "user-1", orgId: "org-1", role: "OWNER" });
    const [header, , signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: "user-1", orgId: "org-1", role: "ADMIN" }),
    ).toString("base64url");
    const tampered = `${header}.${tamperedPayload}.${signature}`;
    expect(() => verifyAccessToken(tampered)).toThrow(InvalidTokenError);
  });

  it("rejects an expired token", () => {
    const expired = jsonwebtoken.sign(
      { sub: "user-1", orgId: "org-1", role: "OWNER" },
      TEST_SECRET,
      { algorithm: "HS256", expiresIn: -10 },
    );
    expect(() => verifyAccessToken(expired)).toThrow(InvalidTokenError);
  });

  it("rejects garbage input without throwing something unexpected", () => {
    expect(() => verifyAccessToken("not.a.jwt")).toThrow(InvalidTokenError);
    expect(() => verifyAccessToken("")).toThrow(InvalidTokenError);
  });

  describe("algorithm confusion / alg:none", () => {
    it("rejects a forged 'alg: none' token even with a valid-shaped payload", () => {
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({ sub: "attacker", orgId: "org-1", role: "OWNER" }),
      ).toString("base64url");
      const forged = `${header}.${payload}.`;
      expect(() => verifyAccessToken(forged)).toThrow(InvalidTokenError);
    });

    it("rejects a token that declares alg:none with a non-empty trailing segment", () => {
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({ sub: "attacker", orgId: "org-1", role: "OWNER" }),
      ).toString("base64url");
      const forged = `${header}.${payload}.anything`;
      expect(() => verifyAccessToken(forged)).toThrow(InvalidTokenError);
    });
  });
});

describe("refresh token sign/verify", () => {
  it("round-trips a valid payload including jti", () => {
    const token = signRefreshToken({ sub: "user-1", orgId: "org-1", jti: "jti-123" });
    const payload = verifyRefreshToken(token);
    expect(payload).toMatchObject({ sub: "user-1", orgId: "org-1", jti: "jti-123" });
  });

  it("rejects a refresh token forged with a different secret", () => {
    const forged = jsonwebtoken.sign(
      { sub: "user-1", orgId: "org-1", jti: "jti-123" },
      "wrong-secret-value-thats-long-enough-too",
      { algorithm: "HS256" },
    );
    expect(() => verifyRefreshToken(forged)).toThrow(InvalidTokenError);
  });
});

describe("secret rotation window", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("accepts a token signed with the previous secret during the overlap window", async () => {
    process.env.JWT_SECRET = "current-secret-thats-at-least-32-characters-long";
    process.env.JWT_SECRET_PREVIOUS = "previous-secret-thats-at-least-32-characters";
    vi.resetModules();

    const jwtLib = await import("../../src/lib/jwt.js");
    const tokenSignedWithOldSecret = jsonwebtoken.sign(
      { sub: "user-1", orgId: "org-1", role: "OWNER" },
      process.env.JWT_SECRET_PREVIOUS,
      { algorithm: "HS256", expiresIn: "15m" },
    );

    const payload = jwtLib.verifyAccessToken(tokenSignedWithOldSecret);
    expect(payload).toMatchObject({ sub: "user-1", orgId: "org-1", role: "OWNER" });
  });

  it("rejects a token signed with neither the current nor the previous secret", async () => {
    process.env.JWT_SECRET = "current-secret-thats-at-least-32-characters-long";
    process.env.JWT_SECRET_PREVIOUS = "previous-secret-thats-at-least-32-characters";
    vi.resetModules();

    const jwtLib = await import("../../src/lib/jwt.js");
    const forged = jsonwebtoken.sign(
      { sub: "user-1", orgId: "org-1", role: "OWNER" },
      "some-third-secret-nobody-configured-at-all-here",
      { algorithm: "HS256" },
    );

    expect(() => jwtLib.verifyAccessToken(forged)).toThrow(jwtLib.InvalidTokenError);
  });
});
