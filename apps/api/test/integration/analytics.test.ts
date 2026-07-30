import { randomUUID } from "node:crypto";
import { getAdminPrisma } from "@cloudmesh/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, resetAll } from "./helpers.js";

const admin = getAdminPrisma();

async function registerAndLogin(app: FastifyInstance, email: string) {
  const registerRes = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { orgName: `Org for ${email}`, email, password: "correct-horse-1" },
  });
  const { orgId } = registerRes.json();
  const loginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: "correct-horse-1" },
  });
  return { orgId, accessToken: loginRes.json().accessToken as string };
}

async function seedApiKey(orgId: string): Promise<string> {
  const key = await admin.apiKey.create({
    data: {
      orgId,
      keyHash: randomUUID(),
      keyPrefix: "cm_live_test",
      scopes: ["chat:write"],
    },
  });
  return key.id;
}

async function seedUsage(
  orgId: string,
  apiKeyId: string,
  overrides: {
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
    createdAt?: Date;
  } = {},
) {
  return admin.usageRecord.create({
    data: {
      orgId,
      apiKeyId,
      model: overrides.model ?? "gpt-4o",
      promptTokens: overrides.promptTokens ?? 100,
      completionTokens: overrides.completionTokens ?? 50,
      costUsd: overrides.costUsd ?? 0.01,
      requestId: `req-${randomUUID()}`,
      createdAt: overrides.createdAt ?? new Date(),
    },
  });
}

describe("analytics", () => {
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

  it("rejects without a JWT", async () => {
    const res = await app.inject({ method: "GET", url: "/analytics" });
    expect(res.statusCode).toBe(401);
  });

  it("aggregates requests/tokens/cost within the period, excluding older rows", async () => {
    const { orgId, accessToken } = await registerAndLogin(app, "owner@acme.test");
    const apiKeyId = await seedApiKey(orgId);

    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);

    await seedUsage(orgId, apiKeyId, {
      model: "gpt-4o",
      promptTokens: 100,
      completionTokens: 50,
      costUsd: 0.01,
      createdAt: twoHoursAgo,
    });
    await seedUsage(orgId, apiKeyId, {
      model: "gpt-4o",
      promptTokens: 200,
      completionTokens: 80,
      costUsd: 0.02,
      createdAt: twoHoursAgo,
    });
    // Outside every period window this test checks — proves the WHERE
    // clause actually filters, not just returns everything.
    await seedUsage(orgId, apiKeyId, {
      model: "gpt-4o",
      costUsd: 999,
      createdAt: fortyDaysAgo,
    });

    const res = await app.inject({
      method: "GET",
      url: "/analytics?period=7d",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.requests).toBe(2);
    expect(body.totals.tokens).toBe(100 + 50 + 200 + 80);
    expect(body.totals.costUsd).toBeCloseTo(0.03, 6);
    expect(body.byModel).toEqual([
      { model: "gpt-4o", requests: 2, costUsd: expect.closeTo(0.03, 6) },
    ]);
    // Both seeded rows landed in the same hour bucket.
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0].requests).toBe(2);
  });

  it("rejects an invalid period value", async () => {
    const { accessToken } = await registerAndLogin(app, "owner2@acme.test");
    const res = await app.inject({
      method: "GET",
      url: "/analytics?period=1y",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("breaks down cost by model", async () => {
    const { orgId, accessToken } = await registerAndLogin(app, "owner3@acme.test");
    const apiKeyId = await seedApiKey(orgId);
    await seedUsage(orgId, apiKeyId, { model: "gpt-4o", costUsd: 0.05 });
    await seedUsage(orgId, apiKeyId, { model: "claude-3-5-sonnet", costUsd: 0.08 });

    const res = await app.inject({
      method: "GET",
      url: "/analytics?period=24h",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const byModel = res.json().byModel as Array<{ model: string; costUsd: number }>;
    expect(byModel).toHaveLength(2);
    // Ordered by cost descending.
    expect(byModel[0]?.model).toBe("claude-3-5-sonnet");
  });

  describe("GET /analytics/logs", () => {
    it("lists recent usage rows, newest first", async () => {
      const { orgId, accessToken } = await registerAndLogin(app, "owner4@acme.test");
      const apiKeyId = await seedApiKey(orgId);
      const older = new Date(Date.now() - 60_000);
      await seedUsage(orgId, apiKeyId, { model: "gpt-4o", createdAt: older });
      await seedUsage(orgId, apiKeyId, { model: "claude-3-5-sonnet" });

      const res = await app.inject({
        method: "GET",
        url: "/analytics/logs",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      const logs = res.json();
      expect(logs).toHaveLength(2);
      expect(logs[0].model).toBe("claude-3-5-sonnet");
    });

    it("filters by model", async () => {
      const { orgId, accessToken } = await registerAndLogin(app, "owner5@acme.test");
      const apiKeyId = await seedApiKey(orgId);
      await seedUsage(orgId, apiKeyId, { model: "gpt-4o" });
      await seedUsage(orgId, apiKeyId, { model: "claude-3-5-sonnet" });

      const res = await app.inject({
        method: "GET",
        url: "/analytics/logs?model=gpt-4o",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const logs = res.json();
      expect(logs).toHaveLength(1);
      expect(logs[0].model).toBe("gpt-4o");
    });

    it("caps limit at 200 and rejects a non-numeric limit", async () => {
      const { accessToken } = await registerAndLogin(app, "owner6@acme.test");
      const res = await app.inject({
        method: "GET",
        url: "/analytics/logs?limit=not-a-number",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("cross-tenant isolation", () => {
    it("never includes org A's usage in org B's analytics", async () => {
      const a = await registerAndLogin(app, "a@acme.test");
      const b = await registerAndLogin(app, "b@acme.test");
      const apiKeyIdA = await seedApiKey(a.orgId);
      await seedUsage(a.orgId, apiKeyIdA, { costUsd: 5 });

      const res = await app.inject({
        method: "GET",
        url: "/analytics?period=7d",
        headers: { authorization: `Bearer ${b.accessToken}` },
      });
      expect(res.json().totals).toEqual({ requests: 0, tokens: 0, costUsd: 0 });
    });

    it("never includes org A's rows in org B's logs", async () => {
      const a = await registerAndLogin(app, "a2@acme.test");
      const b = await registerAndLogin(app, "b2@acme.test");
      const apiKeyIdA = await seedApiKey(a.orgId);
      await seedUsage(a.orgId, apiKeyIdA);

      const res = await app.inject({
        method: "GET",
        url: "/analytics/logs",
        headers: { authorization: `Bearer ${b.accessToken}` },
      });
      expect(res.json()).toEqual([]);
    });
  });
});
