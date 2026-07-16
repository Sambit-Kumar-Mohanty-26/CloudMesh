import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyAccessToken } from "../../src/lib/jwt.js";
import { createTestApp, resetAll } from "./helpers.js";

describe("POST /auth/login", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetAll(app);
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { orgName: "Acme", email: "user@acme.test", password: "correct-horse-1" },
    });
  });

  it("logs in with correct credentials and returns a usable access token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "user@acme.test", password: "correct-horse-1" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTypeOf("string");
    expect(body.user.email).toBe("user@acme.test");
    expect(body.user.role).toBe("OWNER");

    const payload = verifyAccessToken(body.accessToken);
    expect(payload.sub).toBe(body.user.id);
    expect(payload.orgId).toBe(body.user.orgId);
    expect(payload.role).toBe("OWNER");
  });

  it("sets the refresh token as an httpOnly cookie, not in the response body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "user@acme.test", password: "correct-horse-1" },
    });

    const setCookieHeader = res.headers["set-cookie"];
    expect(setCookieHeader).toBeDefined();
    const raw = Array.isArray(setCookieHeader)
      ? setCookieHeader.join(";")
      : String(setCookieHeader);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);

    expect(JSON.stringify(res.json())).not.toMatch(/refresh/i);
  });

  it("never returns the password hash", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "user@acme.test", password: "correct-horse-1" },
    });
    expect(JSON.stringify(res.json())).not.toMatch(/passwordHash/i);
  });

  it("rejects a wrong password with a generic message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "user@acme.test", password: "totally-wrong-password" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Invalid email or password");
  });

  it("rejects a nonexistent email with the SAME generic message (no enumeration)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody-registered@acme.test", password: "whatever-password" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Invalid email or password");
  });

  it("rejects a missing password with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "user@acme.test" },
    });
    expect(res.statusCode).toBe(400);
  });
});
