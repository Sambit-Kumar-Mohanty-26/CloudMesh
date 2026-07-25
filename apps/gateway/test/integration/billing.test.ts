import { getAdminPrisma, resetDatabase, seedBillingPlans } from "@cloudmesh/db";
import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BudgetExceededError } from "../../src/errors.js";
import {
  enforceBudget,
  getBudgetStatus,
  maybePublishBudgetWarning,
  recordUsageAndOutbox,
} from "../../src/lib/billing.js";

const redis = new Redis(process.env.REDIS_URL!);
afterAll(() => redis.disconnect());

const admin = getAdminPrisma();
const LOCK_OPTS = { ttlMs: 2000, retries: 2, retryDelayMs: 20 };

async function createOrg(overrides: {
  plan?: "FREE" | "PRO" | "ENTERPRISE";
  monthlyBudgetOverrideUsd?: number;
}): Promise<string> {
  const org = await admin.organization.create({
    data: {
      name: "Billing Test Org",
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

describe("enforceBudget", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedBillingPlans();
  });

  it("allows a request through when budget remains", async () => {
    const orgId = await createOrg({ plan: "PRO" });
    const status = await enforceBudget(admin, redis, orgId, LOCK_OPTS);
    expect(status.remainingUsd).toBeGreaterThan(0);
  });

  it("throws BudgetExceededError once spend meets or exceeds the budget", async () => {
    const orgId = await createOrg({ plan: "FREE", monthlyBudgetOverrideUsd: 1 });
    const apiKeyId = await createApiKey(orgId);
    await recordUsageAndOutbox(admin, {
      orgId,
      apiKeyId,
      model: "gpt-4o",
      usage: { promptTokens: 1_000_000, completionTokens: 0 }, // $5 at gpt-4o pricing
      requestId: "req-over-budget",
    });

    await expect(enforceBudget(admin, redis, orgId, LOCK_OPTS)).rejects.toThrow(
      BudgetExceededError,
    );
  });

  it("never blocks an org with no billing_plans row for its tier (unlimited)", async () => {
    const orgId = await createOrg({ plan: "ENTERPRISE" }); // ENTERPRISE seeded but let's use an unseeded override scenario instead
    // Delete the seeded ENTERPRISE row to simulate a genuinely unconfigured tier.
    await admin.billingPlan.deleteMany({ where: { planTier: "ENTERPRISE" } });
    const apiKeyId = await createApiKey(orgId);
    await recordUsageAndOutbox(admin, {
      orgId,
      apiKeyId,
      model: "gpt-4o",
      usage: { promptTokens: 10_000_000, completionTokens: 10_000_000 },
      requestId: "req-huge",
    });

    await expect(enforceBudget(admin, redis, orgId, LOCK_OPTS)).resolves.toMatchObject({
      budgetUsd: null,
    });
  });

  it("never lets one org's budget check contend with a different org's lock", async () => {
    const orgA = await createOrg({ plan: "PRO" });
    const orgB = await createOrg({ plan: "PRO" });

    const [a, b] = await Promise.all([
      enforceBudget(admin, redis, orgA, LOCK_OPTS),
      enforceBudget(admin, redis, orgB, LOCK_OPTS),
    ]);
    expect(a.remainingUsd).toBeGreaterThan(0);
    expect(b.remainingUsd).toBeGreaterThan(0);
  });
});

describe("recordUsageAndOutbox", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("computes and stores the correct cost", async () => {
    const orgId = await createOrg({});
    const apiKeyId = await createApiKey(orgId);

    const result = await recordUsageAndOutbox(admin, {
      orgId,
      apiKeyId,
      model: "gpt-4o",
      usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      requestId: "req-1",
    });

    expect(result.recorded).toBe(true);
    expect(result.costUsd).toBeCloseTo(20, 6); // $5 + $15 at gpt-4o pricing

    const status = await getBudgetStatus(admin, orgId);
    expect(status.spentUsd).toBeCloseTo(20, 6);
  });

  it("is idempotent — the same requestId is only ever billed once", async () => {
    const orgId = await createOrg({});
    const apiKeyId = await createApiKey(orgId);
    const params = {
      orgId,
      apiKeyId,
      model: "gpt-4o",
      usage: { promptTokens: 1_000_000, completionTokens: 0 },
      requestId: "req-redelivered",
    };

    const first = await recordUsageAndOutbox(admin, params);
    const second = await recordUsageAndOutbox(admin, params);

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);

    const status = await getBudgetStatus(admin, orgId);
    expect(status.spentUsd).toBeCloseTo(5, 6); // billed once, not twice
  });

  it("writes a transactional outbox event only when the usage row is actually new", async () => {
    const orgId = await createOrg({});
    const apiKeyId = await createApiKey(orgId);
    const params = {
      orgId,
      apiKeyId,
      model: "gpt-4o",
      usage: { promptTokens: 1000, completionTokens: 1000 },
      requestId: "req-outbox",
    };

    await recordUsageAndOutbox(admin, params);
    const afterFirst = await admin.outboxEvent.count({ where: { eventType: "usage.recorded" } });
    expect(afterFirst).toBe(1);

    await recordUsageAndOutbox(admin, params); // redelivered
    const afterSecond = await admin.outboxEvent.count({ where: { eventType: "usage.recorded" } });
    expect(afterSecond).toBe(1); // still just one — no duplicate event for a duplicate record
  });

  it("never mixes one org's usage into another org's spend", async () => {
    const orgA = await createOrg({});
    const orgB = await createOrg({});
    const keyA = await createApiKey(orgA);

    await recordUsageAndOutbox(admin, {
      orgId: orgA,
      apiKeyId: keyA,
      model: "gpt-4o",
      usage: { promptTokens: 1_000_000, completionTokens: 0 },
      requestId: "req-cross-tenant",
    });

    const statusB = await getBudgetStatus(admin, orgB);
    expect(statusB.spentUsd).toBe(0);
  });
});

describe("maybePublishBudgetWarning", () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedBillingPlans();
  });

  it("publishes a budget.warning outbox event once remaining budget drops under 10%", async () => {
    const orgId = await createOrg({ plan: "FREE", monthlyBudgetOverrideUsd: 10 });
    const apiKeyId = await createApiKey(orgId);
    await recordUsageAndOutbox(admin, {
      orgId,
      apiKeyId,
      model: "gpt-4o",
      usage: { promptTokens: 1_820_000, completionTokens: 0 }, // $9.10, 91% spent
      requestId: "req-warn",
    });

    const status = await getBudgetStatus(admin, orgId);
    await maybePublishBudgetWarning(admin, orgId, status);

    const count = await admin.outboxEvent.count({ where: { eventType: "budget.warning" } });
    expect(count).toBe(1);
  });

  it("does not publish a warning while comfortably under the threshold", async () => {
    const orgId = await createOrg({ plan: "PRO" });
    const status = await getBudgetStatus(admin, orgId);
    await maybePublishBudgetWarning(admin, orgId, status);

    const count = await admin.outboxEvent.count({ where: { eventType: "budget.warning" } });
    expect(count).toBe(0);
  });

  it("never publishes a warning for an unlimited (unconfigured) org", async () => {
    const orgId = await createOrg({ plan: "ENTERPRISE" });
    await admin.billingPlan.deleteMany({ where: { planTier: "ENTERPRISE" } });

    const status = await getBudgetStatus(admin, orgId);
    await maybePublishBudgetWarning(admin, orgId, status);

    const count = await admin.outboxEvent.count({ where: { eventType: "budget.warning" } });
    expect(count).toBe(0);
  });
});
