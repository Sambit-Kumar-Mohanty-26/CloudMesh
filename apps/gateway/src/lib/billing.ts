import { withTenant, type PrismaClient } from "@cloudmesh/db";
import { currentPeriodKey, getBudgetStatus, type BudgetStatus } from "@cloudmesh/billing";
import type { Redis } from "ioredis";
import { withDistributedLock, type DistributedLockOptions } from "./billingLock.js";
import { computeCostUsd } from "./pricing.js";
import { writeOutboxEvent } from "./outbox.js";
import type { UnifiedUsage } from "../providers/types.js";
import { BudgetExceededError } from "../errors.js";

export { getBudgetStatus, type BudgetStatus } from "@cloudmesh/billing";

const DEFAULT_LOCK_OPTS: Omit<DistributedLockOptions, "sleep"> = {
  ttlMs: 5000,
  retries: 3,
  retryDelayMs: 50,
};

/**
 * Throws BudgetExceededError (402) if the org has no room left. The lock
 * wraps only this read — NOT the LLM call that follows, and NOT the usage
 * write after that (see lib/billingLock.ts's design doc note: a lock held
 * across a multi-second provider call is a real production hazard, either
 * expiring mid-call and defeating its own purpose, or serializing an org's
 * entire concurrent traffic behind one in-flight request's latency).
 *
 * This means the race the lock exists to narrow — "two concurrent requests
 * both see budget available before either's usage is written" — is only
 * PARTIALLY closed: two requests that both start within the same brief
 * check-to-write gap can both proceed, each within its own lock-protected
 * check, and both complete, pushing total spend somewhat over budget. The
 * overage is bounded (at most as many in-flight concurrent requests as an
 * org can have outstanding at once, not unbounded), which is the standard,
 * accepted trade-off for soft budget caps versus a full reservation system
 * — not something this phase's scope calls for.
 */
export async function enforceBudget(
  db: PrismaClient,
  redis: Redis,
  orgId: string,
  lockOpts: Omit<DistributedLockOptions, "sleep"> = DEFAULT_LOCK_OPTS,
): Promise<BudgetStatus> {
  return withDistributedLock(
    redis,
    `${orgId}:${currentPeriodKey()}`,
    async () => {
      const status = await getBudgetStatus(db, orgId);
      if (status.remainingUsd !== null && status.remainingUsd <= 0) {
        throw new BudgetExceededError(status.remainingUsd);
      }
      return status;
    },
    lockOpts,
  );
}

export interface RecordUsageParams {
  orgId: string;
  apiKeyId: string;
  model: string;
  usage: UnifiedUsage;
  /** Idempotency key for the usage_records row itself (ON CONFLICT (request_id)
   *  DO NOTHING) — distinct from the client's Idempotency-Key header. The
   *  provider response's own `id` is used at the call site, so a genuinely
   *  redelivered/duplicate recording attempt for the same completed
   *  response never double-bills. */
  requestId: string;
}

export interface RecordUsageResult {
  costUsd: number;
  /** false if this requestId was already recorded (a duplicate/redelivery)
   *  — the row and its outbox event were both skipped, not just the row. */
  recorded: boolean;
}

/** Idempotent usage_records insert (ON CONFLICT (request_id) DO NOTHING, per
 *  the design doc's exact SQL) + a transactional outbox event, so a request
 *  that arrives twice (Phase 10's at-least-once NATS redelivery, per the
 *  design doc's own framing) is billed once, not twice — checked by a real
 *  test, not assumed. Not lock-protected: concurrent INSERTs into
 *  usage_records don't need serializing for correctness, only budget
 *  *checks* (see enforceBudget) do. */
export async function recordUsageAndOutbox(
  db: PrismaClient,
  params: RecordUsageParams,
): Promise<RecordUsageResult> {
  const costUsd = computeCostUsd(params.model, params.usage);
  const recorded = await withTenant(db, params.orgId, async (tx) => {
    const affected = await tx.$executeRaw`
      INSERT INTO usage_records (id, org_id, api_key_id, model, prompt_tokens, completion_tokens, cost_usd, request_id)
      VALUES (
        gen_random_uuid(), ${params.orgId}::uuid, ${params.apiKeyId}::uuid, ${params.model},
        ${params.usage.promptTokens}, ${params.usage.completionTokens}, ${costUsd}, ${params.requestId}
      )
      ON CONFLICT (request_id) DO NOTHING
    `;
    if (affected > 0) {
      await writeOutboxEvent(tx, "usage.recorded", {
        orgId: params.orgId,
        apiKeyId: params.apiKeyId,
        model: params.model,
        promptTokens: params.usage.promptTokens,
        completionTokens: params.usage.completionTokens,
        costUsd,
        requestId: params.requestId,
      });
    }
    return affected > 0;
  });
  return { costUsd, recorded };
}

/** Fire-and-forget-safe: publishes a budget.warning outbox event once an
 *  org's remaining budget drops under 10% — the design doc's "webhook"
 *  deliverable. Actual outbound HTTP delivery to a customer-configured URL
 *  isn't built (no such config exists on Organization yet, and building
 *  signing/retry for outbound webhooks is a separate feature, not core to
 *  this phase) — this publishes the signal onto the same outbox a real
 *  webhook-delivery consumer could subscribe to once one exists. */
export async function maybePublishBudgetWarning(
  db: PrismaClient,
  orgId: string,
  status: BudgetStatus,
): Promise<void> {
  if (status.budgetUsd === null || status.remainingFraction >= 0.1) return;
  await withTenant(db, orgId, (tx) =>
    writeOutboxEvent(tx, "budget.warning", {
      orgId,
      spentUsd: status.spentUsd,
      budgetUsd: status.budgetUsd,
      remainingFraction: status.remainingFraction,
    }),
  );
}
