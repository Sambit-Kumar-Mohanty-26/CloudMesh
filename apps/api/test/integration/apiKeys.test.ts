import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, resetAll } from "./helpers.js";

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
  return loginRes.json().accessToken as string;
}

describe("API key lifecycle", () => {
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

  it("rejects key creation without a JWT", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api-keys",
      payload: { scopes: ["chat:read"] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("creates a key and returns the raw value exactly once", async () => {
    const accessToken = await registerAndLogin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { scopes: ["chat:read", "chat:write"], rateLimitRpm: 500 },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.rawKey).toMatch(/^cm_live_/);
    expect(body.scopes).toEqual(["chat:read", "chat:write"]);
    expect(body.rateLimitRpm).toBe(500);
  });

  it("the raw key works for authenticating against a protected route (full chain, DB cold path)", async () => {
    const accessToken = await registerAndLogin(app);
    const created = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { scopes: ["chat:read"] },
    });
    const { rawKey } = created.json();

    const whoami = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `Bearer ${rawKey}` },
    });

    expect(whoami.statusCode).toBe(200);
    expect(whoami.json().scopes).toEqual(["chat:read"]);
  });

  it("the raw key works on a second request via the Redis cache (warm path)", async () => {
    const accessToken = await registerAndLogin(app);
    const created = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { scopes: ["chat:read"] },
    });
    const { rawKey } = created.json();

    await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    const second = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(second.statusCode).toBe(200);
  });

  it("rejects an invalid API key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: "Bearer cm_live_totally-made-up-key" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a missing Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/whoami" });
    expect(res.statusCode).toBe(401);
  });

  it("lists keys without ever exposing keyHash or the raw key", async () => {
    const accessToken = await registerAndLogin(app);
    const created = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { scopes: ["chat:read"] },
    });
    const { rawKey } = created.json();

    const res = await app.inject({
      method: "GET",
      url: "/api-keys",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const keys = res.json();
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toHaveProperty("keyHash");
    // keyPrefix legitimately starts with "cm_live_" (it's meant to be
    // shown, like Stripe's pk_live_ prefixes) — what must never reappear
    // is the full secret raw key itself.
    expect(JSON.stringify(keys)).not.toContain(rawKey);
  });

  it("revoking a key makes it stop working immediately, including from a warm Redis cache", async () => {
    const accessToken = await registerAndLogin(app);
    const created = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { scopes: ["chat:read"] },
    });
    const { id, rawKey } = created.json();

    // Warm the cache first.
    const before = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(before.statusCode).toBe(200);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api-keys/${id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(revoke.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("revoking a nonexistent key id returns 404, not 500", async () => {
    const accessToken = await registerAndLogin(app);
    const res = await app.inject({
      method: "DELETE",
      url: "/api-keys/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects key creation with an empty scopes array", async () => {
    const accessToken = await registerAndLogin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api-keys",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { scopes: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});
