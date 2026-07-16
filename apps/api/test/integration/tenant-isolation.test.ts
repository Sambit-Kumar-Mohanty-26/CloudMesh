import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, resetAll } from "./helpers.js";

async function registerAndLogin(app: FastifyInstance, email: string) {
  await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { orgName: `Org for ${email}`, email, password: "correct-horse-1" },
  });
  const loginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: "correct-horse-1" },
  });
  return loginRes.json().accessToken as string;
}

describe("cross-tenant isolation", () => {
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

  it("org B cannot see org A's API keys in its own list", async () => {
    const tokenA = await registerAndLogin(app, "a@orgA.test");
    const tokenB = await registerAndLogin(app, "b@orgB.test");

    await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { scopes: ["chat:read"] },
    });

    const listB = await app.inject({
      method: "GET",
      url: "/api-keys",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(listB.json()).toEqual([]);

    const listA = await app.inject({
      method: "GET",
      url: "/api-keys",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(listA.json()).toHaveLength(1);
  });

  it("org B cannot revoke org A's key by id (404, not 403 — doesn't confirm existence)", async () => {
    const tokenA = await registerAndLogin(app, "a@orgA.test");
    const tokenB = await registerAndLogin(app, "b@orgB.test");

    const created = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { scopes: ["chat:read"] },
    });
    const { id, rawKey } = created.json();

    const revokeAttempt = await app.inject({
      method: "DELETE",
      url: `/api-keys/${id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(revokeAttempt.statusCode).toBe(404);

    // And the key must still actually work — org B's failed attempt had no effect.
    const whoami = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(whoami.statusCode).toBe(200);
  });

  it("each org's API key resolves to that org's own id, never the other's", async () => {
    const tokenA = await registerAndLogin(app, "a@orgA.test");
    const tokenB = await registerAndLogin(app, "b@orgB.test");

    const keyA = (
      await app.inject({
        method: "POST",
        url: "/api-keys",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { scopes: ["chat:read"] },
      })
    ).json();
    const keyB = (
      await app.inject({
        method: "POST",
        url: "/api-keys",
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { scopes: ["chat:read"] },
      })
    ).json();

    const whoamiA = (
      await app.inject({
        method: "GET",
        url: "/v1/whoami",
        headers: { authorization: `Bearer ${keyA.rawKey}` },
      })
    ).json();
    const whoamiB = (
      await app.inject({
        method: "GET",
        url: "/v1/whoami",
        headers: { authorization: `Bearer ${keyB.rawKey}` },
      })
    ).json();

    expect(whoamiA.orgId).not.toBe(whoamiB.orgId);
  });
});
