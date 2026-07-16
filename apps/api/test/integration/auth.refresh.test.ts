import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, extractSetCookie, resetAll } from "./helpers.js";

const COOKIE_NAME = "cm_refresh_token";

async function registerAndLogin(app: FastifyInstance, email = "user@acme.test") {
  await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { orgName: "Acme", email, password: "correct-horse-1" },
  });
  const loginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: "correct-horse-1" },
  });
  const refreshCookie = extractSetCookie(loginRes.headers["set-cookie"], COOKIE_NAME)!;
  return { accessToken: loginRes.json().accessToken as string, refreshCookie };
}

describe("POST /auth/refresh", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetAll(app);
  });

  it("issues a new access token given a valid refresh cookie", async () => {
    const { refreshCookie } = await registerAndLogin(app);

    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { [COOKIE_NAME]: refreshCookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTypeOf("string");
  });

  it("rotates the refresh cookie to a new value", async () => {
    const { refreshCookie } = await registerAndLogin(app);

    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { [COOKIE_NAME]: refreshCookie },
    });

    const newCookie = extractSetCookie(res.headers["set-cookie"], COOKIE_NAME);
    expect(newCookie).toBeDefined();
    expect(newCookie).not.toBe(refreshCookie);
  });

  it("rejects reuse of an already-rotated refresh token (replay detection)", async () => {
    const { refreshCookie } = await registerAndLogin(app);

    const first = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { [COOKIE_NAME]: refreshCookie },
    });
    expect(first.statusCode).toBe(200);

    // Replay the SAME (now-rotated-away) refresh token.
    const replay = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { [COOKIE_NAME]: refreshCookie },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("rejects a missing refresh cookie with 401", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/refresh" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a tampered refresh cookie with 401", async () => {
    const { refreshCookie } = await registerAndLogin(app);
    const tampered = refreshCookie.slice(0, -3) + "xyz";

    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { [COOKIE_NAME]: tampered },
    });
    expect(res.statusCode).toBe(401);
  });

  it("logout invalidates the refresh token immediately", async () => {
    const { refreshCookie } = await registerAndLogin(app);

    const logoutRes = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { [COOKIE_NAME]: refreshCookie },
    });
    expect(logoutRes.statusCode).toBe(204);

    const refreshAfterLogout = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { [COOKIE_NAME]: refreshCookie },
    });
    expect(refreshAfterLogout.statusCode).toBe(401);
  });

  it("logout is idempotent — calling it twice is not an error", async () => {
    const { refreshCookie } = await registerAndLogin(app);
    const first = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { [COOKIE_NAME]: refreshCookie },
    });
    const second = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { [COOKIE_NAME]: refreshCookie },
    });
    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);
  });

  it("a refreshed access token reflects the user's current role", async () => {
    const { refreshCookie } = await registerAndLogin(app);
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      cookies: { [COOKIE_NAME]: refreshCookie },
    });
    const { verifyAccessToken } = await import("../../src/lib/jwt.js");
    const payload = verifyAccessToken(res.json().accessToken);
    expect(payload.role).toBe("OWNER");
  });
});
