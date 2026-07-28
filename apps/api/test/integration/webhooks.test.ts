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

describe("webhook endpoint management", () => {
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

  it("rejects registration without a JWT", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks",
      payload: { url: "https://example.com/hook", eventTypes: ["job.completed"] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("registers a webhook and returns the secret exactly once", async () => {
    const accessToken = await registerAndLogin(app, "owner@acme.test");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { url: "https://example.com/hook", eventTypes: ["job.completed", "job.failed"] },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.eventTypes).toEqual(["job.completed", "job.failed"]);

    // The secret never reappears on a subsequent list.
    const list = await app.inject({
      method: "GET",
      url: "/webhooks",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(JSON.stringify(list.json())).not.toContain(body.secret);
  });

  it("rejects an empty eventTypes array", async () => {
    const accessToken = await registerAndLogin(app, "owner2@acme.test");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { url: "https://example.com/hook", eventTypes: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unrecognized event type", async () => {
    const accessToken = await registerAndLogin(app, "owner3@acme.test");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { url: "https://example.com/hook", eventTypes: ["totally.made.up"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an oversized URL rather than storing or SSRF-checking it", async () => {
    const accessToken = await registerAndLogin(app, "owner-oversized@acme.test");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        url: `https://example.com/${"a".repeat(3000)}`,
        eventTypes: ["job.completed"],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("ignores unexpected extra fields instead of applying them (no mass assignment)", async () => {
    const accessToken = await registerAndLogin(app, "owner-mass@acme.test");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        url: "https://example.com/hook",
        eventTypes: ["job.completed"],
        // An attacker-supplied secret/orgId/isActive must never override
        // what the server itself generates or derives from the JWT.
        secret: "whsec_attacker_supplied",
        orgId: "00000000-0000-0000-0000-000000000000",
        isActive: false,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.secret).not.toBe("whsec_attacker_supplied");
    expect(body.secret).toMatch(/^whsec_/);
  });

  describe("SSRF rejection at registration time", () => {
    const accessTokenFor = async () => registerAndLogin(app, "ssrf-owner@acme.test");

    it("rejects a plain http URL", async () => {
      const accessToken = await accessTokenFor();
      const res = await app.inject({
        method: "POST",
        url: "/webhooks",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { url: "http://example.com/hook", eventTypes: ["job.completed"] },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a loopback target", async () => {
      const accessToken = await accessTokenFor();
      const res = await app.inject({
        method: "POST",
        url: "/webhooks",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { url: "https://127.0.0.1/hook", eventTypes: ["job.completed"] },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects the cloud metadata endpoint", async () => {
      const accessToken = await accessTokenFor();
      const res = await app.inject({
        method: "POST",
        url: "/webhooks",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          url: "https://169.254.169.254/latest/meta-data/",
          eventTypes: ["job.completed"],
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a private RFC1918 address", async () => {
      const accessToken = await accessTokenFor();
      const res = await app.inject({
        method: "POST",
        url: "/webhooks",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { url: "https://10.0.0.5/hook", eventTypes: ["job.completed"] },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  it("deletes an endpoint, and a repeat delete 404s", async () => {
    const accessToken = await registerAndLogin(app, "owner4@acme.test");
    const created = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { url: "https://example.com/hook", eventTypes: ["job.completed"] },
    });
    const { id } = created.json();

    const del = await app.inject({
      method: "DELETE",
      url: `/webhooks/${id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(del.statusCode).toBe(204);

    const again = await app.inject({
      method: "DELETE",
      url: `/webhooks/${id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(again.statusCode).toBe(404);
  });

  it("deleting a nonexistent id returns 404, not 500", async () => {
    const accessToken = await registerAndLogin(app, "owner5@acme.test");
    const res = await app.inject({
      method: "DELETE",
      url: "/webhooks/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("lists deliveries for an endpoint (empty until something is dispatched)", async () => {
    const accessToken = await registerAndLogin(app, "owner6@acme.test");
    const created = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { url: "https://example.com/hook", eventTypes: ["job.completed"] },
    });
    const { id } = created.json();

    const res = await app.inject({
      method: "GET",
      url: `/webhooks/${id}/deliveries`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  describe("cross-tenant isolation", () => {
    it("org B cannot see org A's webhook endpoint in its own list", async () => {
      const tokenA = await registerAndLogin(app, "a@acme.test");
      const tokenB = await registerAndLogin(app, "b@acme.test");

      await app.inject({
        method: "POST",
        url: "/webhooks",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { url: "https://example.com/a-hook", eventTypes: ["job.completed"] },
      });

      const listB = await app.inject({
        method: "GET",
        url: "/webhooks",
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(listB.json()).toEqual([]);
    });

    it("org B cannot delete org A's endpoint by id (404, not 403 — doesn't confirm existence)", async () => {
      const tokenA = await registerAndLogin(app, "a2@acme.test");
      const tokenB = await registerAndLogin(app, "b2@acme.test");

      const created = await app.inject({
        method: "POST",
        url: "/webhooks",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { url: "https://example.com/a-hook", eventTypes: ["job.completed"] },
      });
      const { id } = created.json();

      const del = await app.inject({
        method: "DELETE",
        url: `/webhooks/${id}`,
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(del.statusCode).toBe(404);

      // Still there for org A — the cross-tenant delete attempt didn't work.
      const listA = await app.inject({
        method: "GET",
        url: "/webhooks",
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(listA.json()).toHaveLength(1);
    });

    it("org B cannot read org A's endpoint's deliveries", async () => {
      const tokenA = await registerAndLogin(app, "a3@acme.test");
      const tokenB = await registerAndLogin(app, "b3@acme.test");

      const created = await app.inject({
        method: "POST",
        url: "/webhooks",
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { url: "https://example.com/a-hook", eventTypes: ["job.completed"] },
      });
      const { id } = created.json();

      const res = await app.inject({
        method: "GET",
        url: `/webhooks/${id}/deliveries`,
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });
  });
});
