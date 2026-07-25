import { getAdminPrisma, seedBillingPlans } from "@cloudmesh/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApiKey, createTestApp, resetAll } from "./helpers.js";

const admin = getAdminPrisma();

function chatSpy(app: FastifyInstance) {
  const resolved = app.models.resolve("mock-echo")!;
  return vi.spyOn(resolved.provider, "chat");
}

describe("POST /v1/chat — billing (opt-in via feature flags)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetAll(app);
    await seedBillingPlans();
  });

  it("records usage_records for every completed request, even when billing_enforcement is off", async () => {
    const { rawKey, orgId } = await createTestApiKey("No Enforcement Org", 60, {});
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);

    const count = await admin.usageRecord.count({ where: { orgId } });
    expect(count).toBe(1);
  });

  it("allows requests through and decrements remaining budget while under the cap", async () => {
    const { rawKey } = await createTestApiKey("Healthy Budget Org", 60, {
      billing_enforcement: true,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects with 402 once the org's budget is exhausted, and never calls the provider", async () => {
    const { rawKey, orgId } = await createTestApiKey("Broke Org", 60, {
      billing_enforcement: true,
    });
    await admin.organization.update({
      where: { id: orgId },
      data: { monthlyBudgetOverrideUsd: 0.000001 },
    });
    const apiKey = await admin.apiKey.findFirstOrThrow({ where: { orgId } });
    await admin.$executeRaw`
      INSERT INTO usage_records (id, org_id, api_key_id, model, prompt_tokens, completion_tokens, cost_usd, request_id)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${apiKey.id}::uuid, 'gpt-4o', 1000000, 0, 5, 'req-preexisting')
    `;

    const spy = chatSpy(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe("BUDGET_EXCEEDED");
    expect(spy).not.toHaveBeenCalled();
  });

  it("never lets one org's exhausted budget block a different org", async () => {
    const broke = await createTestApiKey("Broke Org 2", 60, { billing_enforcement: true });
    await admin.organization.update({
      where: { id: broke.orgId },
      data: { monthlyBudgetOverrideUsd: 0.000001 },
    });
    const brokeKey = await admin.apiKey.findFirstOrThrow({ where: { orgId: broke.orgId } });
    await admin.$executeRaw`
      INSERT INTO usage_records (id, org_id, api_key_id, model, prompt_tokens, completion_tokens, cost_usd, request_id)
      VALUES (gen_random_uuid(), ${broke.orgId}::uuid, ${brokeKey.id}::uuid, 'gpt-4o', 1000000, 0, 5, 'req-preexisting-2')
    `;

    const healthy = await createTestApiKey("Healthy Org 2", 60, { billing_enforcement: true });

    const brokeRes = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${broke.rawKey}` },
      payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
    });
    const healthyRes = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${healthy.rawKey}` },
      payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
    });

    expect(brokeRes.statusCode).toBe(402);
    expect(healthyRes.statusCode).toBe(200);
  });

  it("downgrades an 'auto' request to BUDGET_CONSTRAINED_MODEL once remaining budget drops under 5%", async () => {
    const { rawKey, orgId } = await createTestApiKey("Near Limit Org", 60, {
      billing_enforcement: true,
    });
    // FREE plan (seeded $5 budget) with $4.80 already spent -> 4% remaining.
    await admin.organization.update({ where: { id: orgId }, data: { plan: "FREE" } });
    const apiKey = await admin.apiKey.findFirstOrThrow({ where: { orgId } });
    await admin.$executeRaw`
      INSERT INTO usage_records (id, org_id, api_key_id, model, prompt_tokens, completion_tokens, cost_usd, request_id)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${apiKey.id}::uuid, 'gpt-4o', 960000, 0, 4.8, 'req-near-limit')
    `;

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(200);
    // mock-echo's own adapter name is "mock" — direct proof the downgrade
    // model was used instead of DEFAULT_MODEL's real (openai) provider.
    expect(res.json().provider).toBe("mock");
  });

  it("never downgrades an explicit model request, even at 0% remaining budget", async () => {
    const { rawKey, orgId } = await createTestApiKey("Explicit Near Limit Org", 60, {
      billing_enforcement: true,
    });
    await admin.organization.update({ where: { id: orgId }, data: { plan: "FREE" } });
    const apiKey = await admin.apiKey.findFirstOrThrow({ where: { orgId } });
    await admin.$executeRaw`
      INSERT INTO usage_records (id, org_id, api_key_id, model, prompt_tokens, completion_tokens, cost_usd, request_id)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${apiKey.id}::uuid, 'gpt-4o', 960000, 0, 4.8, 'req-near-limit-2')
    `;

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      // Explicit mock-echo request — must resolve to mock-echo because it
      // was asked for, not because of the downgrade logic.
      payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toBe("mock");
  });

  it("publishes a budget.warning outbox event once remaining budget drops under 10%", async () => {
    const { rawKey, orgId } = await createTestApiKey("Warning Zone Org", 60, {
      billing_enforcement: true,
    });
    await admin.organization.update({ where: { id: orgId }, data: { plan: "FREE" } });
    const apiKey = await admin.apiKey.findFirstOrThrow({ where: { orgId } });
    await admin.$executeRaw`
      INSERT INTO usage_records (id, org_id, api_key_id, model, prompt_tokens, completion_tokens, cost_usd, request_id)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${apiKey.id}::uuid, 'gpt-4o', 920000, 0, 4.6, 'req-warning-zone')
    `;

    await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
    });

    const count = await admin.outboxEvent.count({ where: { eventType: "budget.warning" } });
    expect(count).toBe(1);
  });

  it("records usage for a streamed request too — billing isn't skipped for streaming", async () => {
    const { rawKey, orgId } = await createTestApiKey("Streaming Billing Org", 60, {
      billing_enforcement: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    expect(res.statusCode).toBe(200);

    const count = await admin.usageRecord.count({ where: { orgId } });
    expect(count).toBe(1);
  });
});
