import { getAdminPrisma } from "./client.js";

/**
 * Truncates every application table. Test-only — uses the admin (RLS-
 * bypassing) connection on purpose, since a test role restricted by RLS
 * couldn't clean up rows across tenants anyway. Never call this outside a
 * test setup/teardown hook.
 */
export async function resetDatabase(): Promise<void> {
  const prisma = getAdminPrisma();
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "usage_records", "semantic_cache", "api_keys", "users", "organizations", "billing_plans", "invoices", "stripe_events", "outbox_events", "jobs", "audit_log", "webhook_deliveries", "webhook_events", "webhook_endpoints" RESTART IDENTITY CASCADE;`,
  );
}

/**
 * billing_plans is global catalog data (seeded once in real deployments,
 * via packages/db/prisma/seed.ts), not per-org test fixtures — but
 * resetDatabase() truncates it along with everything else for full test
 * isolation, so any test that exercises budget enforcement needs to
 * re-seed it. Test-only, same admin-connection rationale as resetDatabase.
 */
export async function seedBillingPlans(): Promise<void> {
  const prisma = getAdminPrisma();
  await prisma.billingPlan.createMany({
    data: [
      { planTier: "FREE", monthlyBudgetUsd: 5, priceUsd: 0 },
      { planTier: "PRO", monthlyBudgetUsd: 100, priceUsd: 49 },
      { planTier: "ENTERPRISE", monthlyBudgetUsd: 2000, priceUsd: 999 },
    ],
  });
}
