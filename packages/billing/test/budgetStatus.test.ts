import { getAdminPrisma, getAppPrisma, resetDatabase, withTenant } from "@cloudmesh/db";
import { beforeEach, describe, expect, it } from "vitest";
import { getBudgetStatus } from "../src/budgetStatus.js";

const admin = getAdminPrisma();
const app = getAppPrisma();

async function createOrg(overrides: {
  plan?: "FREE" | "PRO" | "ENTERPRISE";
  monthlyBudgetOverrideUsd?: number;
}): Promise<string> {
  const org = await admin.organization.create({
    data: {
      name: "Budget Test Org",
      plan: overrides.plan ?? "PRO",
      monthlyBudgetOverrideUsd: overrides.monthlyBudgetOverrideUsd,
    },
  });
  return org.id;
}

async function createApiKey(orgId: string): Promise<string> {
  const key = await admin.apiKey.create({
    data: {
      orgId,
      keyHash: `hash-${orgId}-${Math.random()}`,
      keyPrefix: "cm_live_test",
      scopes: [],
    },
  });
  return key.id;
}

async function recordUsage(
  orgId: string,
  apiKeyId: string,
  costUsd: number,
  createdAt: Date = new Date(),
): Promise<void> {
  await withTenant(
    app,
    orgId,
    (tx) =>
      tx.$executeRaw`
      INSERT INTO usage_records (id, org_id, api_key_id, model, prompt_tokens, completion_tokens, cost_usd, request_id, created_at)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${apiKeyId}::uuid, 'gpt-4o', 100, 100, ${costUsd}, ${`req-${Math.random()}`}, ${createdAt})
    `,
  );
}

describe("getBudgetStatus", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("uses the plan's default budget when no per-org override is set", async () => {
    await admin.billingPlan.create({
      data: { planTier: "PRO", monthlyBudgetUsd: 100, priceUsd: 49 },
    });
    const orgId = await createOrg({ plan: "PRO" });

    const status = await getBudgetStatus(app, orgId);
    expect(status.budgetUsd).toBe(100);
    expect(status.spentUsd).toBe(0);
    expect(status.remainingUsd).toBe(100);
    expect(status.remainingFraction).toBe(1);
  });

  it("a per-org override takes precedence over the plan's default", async () => {
    await admin.billingPlan.create({
      data: { planTier: "PRO", monthlyBudgetUsd: 100, priceUsd: 49 },
    });
    const orgId = await createOrg({ plan: "PRO", monthlyBudgetOverrideUsd: 500 });

    const status = await getBudgetStatus(app, orgId);
    expect(status.budgetUsd).toBe(500);
  });

  it("is unlimited (budgetUsd null) when the org's plan tier has no seeded billing_plans row", async () => {
    const orgId = await createOrg({ plan: "ENTERPRISE" }); // no ENTERPRISE row seeded

    const status = await getBudgetStatus(app, orgId);
    expect(status.budgetUsd).toBeNull();
    expect(status.remainingUsd).toBeNull();
    expect(status.remainingFraction).toBe(1);
  });

  it("sums this month's usage_records into spentUsd", async () => {
    await admin.billingPlan.create({
      data: { planTier: "PRO", monthlyBudgetUsd: 100, priceUsd: 49 },
    });
    const orgId = await createOrg({ plan: "PRO" });
    const apiKeyId = await createApiKey(orgId);

    await recordUsage(orgId, apiKeyId, 10);
    await recordUsage(orgId, apiKeyId, 15.5);

    const status = await getBudgetStatus(app, orgId);
    expect(status.spentUsd).toBeCloseTo(25.5, 6);
    expect(status.remainingUsd).toBeCloseTo(74.5, 6);
    expect(status.remainingFraction).toBeCloseTo(0.745, 6);
  });

  it("excludes usage from a previous month", async () => {
    await admin.billingPlan.create({
      data: { planTier: "PRO", monthlyBudgetUsd: 100, priceUsd: 49 },
    });
    const orgId = await createOrg({ plan: "PRO" });
    const apiKeyId = await createApiKey(orgId);

    const lastMonth = new Date();
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    await recordUsage(orgId, apiKeyId, 999, lastMonth);

    const status = await getBudgetStatus(app, orgId);
    expect(status.spentUsd).toBe(0);
  });

  it("never sums another org's usage into this org's spentUsd", async () => {
    await admin.billingPlan.create({
      data: { planTier: "PRO", monthlyBudgetUsd: 100, priceUsd: 49 },
    });
    const orgA = await createOrg({ plan: "PRO" });
    const orgB = await createOrg({ plan: "PRO" });
    const keyA = await createApiKey(orgA);
    const keyB = await createApiKey(orgB);

    await recordUsage(orgA, keyA, 50);
    await recordUsage(orgB, keyB, 5);

    const statusA = await getBudgetStatus(app, orgA);
    const statusB = await getBudgetStatus(app, orgB);
    expect(statusA.spentUsd).toBe(50);
    expect(statusB.spentUsd).toBe(5);
  });

  it("remainingUsd can go negative once spend exceeds budget", async () => {
    await admin.billingPlan.create({
      data: { planTier: "FREE", monthlyBudgetUsd: 5, priceUsd: 0 },
    });
    const orgId = await createOrg({ plan: "FREE" });
    const apiKeyId = await createApiKey(orgId);

    await recordUsage(orgId, apiKeyId, 8);

    const status = await getBudgetStatus(app, orgId);
    expect(status.remainingUsd).toBeCloseTo(-3, 6);
    expect(status.remainingFraction).toBeLessThan(0);
  });
});
