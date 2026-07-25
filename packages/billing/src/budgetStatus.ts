import { withTenant, type PrismaClient } from "@cloudmesh/db";

export interface BudgetStatus {
  spentUsd: number;
  /** null = no billing_plans row for this org's tier and no per-org
   *  override — treated as unlimited (fail open on missing config, not
   *  fail closed) rather than silently blocking every request for an org
   *  whose plan tier was never seeded. */
  budgetUsd: number | null;
  remainingUsd: number | null;
  /** 1 = full budget remaining, 0 = exactly at cap, negative = over.
   *  1 (not null) when budgetUsd is null, since "unlimited" has no
   *  meaningful fraction-remaining and callers checking `< 0.1`/`< 0.05`
   *  should just never trigger for an unlimited org. */
  remainingFraction: number;
}

function startOfCurrentMonthUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Month-granularity key, e.g. "2026-07" — a natural monthly reset boundary
 *  (a new month's spend starts back at $0 simply because the SUM query's
 *  window moves, no explicit reset job required), and reused by
 *  apps/gateway as the billing distributed lock's period component. */
export function currentPeriodKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Shared between apps/gateway (which enforces it) and apps/api (which just
 * displays it) — same rationale as packages/auth's resolveApiKey: this
 * logic exists in exactly one place so the two services can't drift.
 */
export async function getBudgetStatus(
  db: PrismaClient,
  orgId: string,
  now: Date = new Date(),
): Promise<BudgetStatus> {
  const org = await db.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: { plan: true, monthlyBudgetOverrideUsd: true },
  });

  let budgetUsd: number | null = org.monthlyBudgetOverrideUsd
    ? Number(org.monthlyBudgetOverrideUsd)
    : null;
  if (budgetUsd === null) {
    const plan = await db.billingPlan.findUnique({ where: { planTier: org.plan } });
    budgetUsd = plan ? Number(plan.monthlyBudgetUsd) : null;
  }

  const sum = await withTenant(db, orgId, (tx) =>
    tx.usageRecord.aggregate({
      where: { orgId, createdAt: { gte: startOfCurrentMonthUtc(now) } },
      _sum: { costUsd: true },
    }),
  );
  const spentUsd = Number(sum._sum.costUsd ?? 0);

  if (budgetUsd === null) {
    return { spentUsd, budgetUsd: null, remainingUsd: null, remainingFraction: 1 };
  }
  const remainingUsd = budgetUsd - spentUsd;
  return {
    spentUsd,
    budgetUsd,
    remainingUsd,
    remainingFraction: budgetUsd > 0 ? remainingUsd / budgetUsd : 0,
  };
}
