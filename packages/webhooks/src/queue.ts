import type { PrismaClient } from "@cloudmesh/db";
import { Queue, Worker, type Job as BullJob } from "bullmq";
import type { Redis } from "ioredis";
import { attemptDelivery } from "./deliver.js";
import { isSafeWebhookTarget, type SsrfCheckResult } from "./ssrf.js";
import { recordDeliveryAttempt } from "./service.js";
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_QUEUE_NAME,
  WEBHOOK_QUEUE_PREFIX,
  WEBHOOK_RETRY_SCHEDULE_MS,
  type WebhookJobData,
} from "./types.js";

/** Same connection-sharing rule Phase 9's queue.ts documents: BullMQ needs
 *  `maxRetriesPerRequest: null` for its blocking commands, so it gets its
 *  own duplicated Redis connection rather than mutating the app's shared
 *  client (which the rate limiter, circuit breaker, and cache all depend
 *  on keeping its own retry semantics). */
export function createWebhookQueue(redis: Redis): Queue<WebhookJobData> {
  return new Queue<WebhookJobData>(WEBHOOK_QUEUE_NAME, {
    prefix: WEBHOOK_QUEUE_PREFIX,
    connection: redis.duplicate({ maxRetriesPerRequest: null }),
  });
}

/**
 * The design doc's literal, non-exponential retry schedule: 1s, 5s, 30s,
 * 5min, 30min. `attemptsMade` is 0 on the very first retry BullMQ computes
 * a delay for (i.e. after the initial attempt has already failed once), so
 * it indexes directly into the schedule array.
 *
 * Takes the schedule as a parameter rather than closing over the constant
 * directly so tests can inject a millisecond-scale schedule — the real one
 * tops out at 30 minutes, and no test should (or safely could) wait that
 * long. Only the timings are ever swapped in tests; the retry/outcome
 * LOGIC this schedule feeds is exercised against the same code path either
 * way.
 */
function makeBackoffStrategy(schedule: number[]) {
  return (attemptsMade: number): number => schedule[attemptsMade] ?? schedule.at(-1)!;
}

export interface WebhookWorkerOptions {
  concurrency?: number;
  db: PrismaClient;
  onError?: (err: unknown) => void;
  /** Test-only override — see makeBackoffStrategy's comment. Defaults to
   *  the real design-doc schedule. */
  retryScheduleMs?: number[];
  /** Test-only override — see attemptDelivery's `checkTarget` parameter.
   *  Defaults to the real `isSafeWebhookTarget`; production code never sets
   *  this. */
  checkTarget?: (url: string) => Promise<SsrfCheckResult>;
}

/**
 * The delivery worker. One BullMQ job = one delivery attempt series for one
 * (endpoint, event) pair; `attemptDelivery` classifies the HTTP outcome and
 * this wrapper turns that classification into BullMQ retry behavior:
 *
 *   "delivered" -> resolve (done, DELIVERED)
 *   "rejected"  -> resolve (done, FAILED — a 4xx/redirect/SSRF block is
 *                  final by design; resolving rather than throwing means
 *                  BullMQ does NOT retry it, matching "4xx: do not retry")
 *   "retry"     -> throw (BullMQ retries per the schedule above)
 *
 * The processor always records the attempt as (still) PENDING before
 * throwing on a "retry" outcome — it does not try to guess whether this was
 * the LAST retry, the same lesson as Phase 9's job worker: that
 * determination belongs to BullMQ's own `attemptsMade` bookkeeping, checked
 * in the `failed` listener below, not duplicated here.
 */
export function createWebhookWorker(
  redis: Redis,
  opts: WebhookWorkerOptions,
): Worker<WebhookJobData> {
  const worker = new Worker<WebhookJobData>(
    WEBHOOK_QUEUE_NAME,
    async (bullJob: BullJob<WebhookJobData>) => {
      const { deliveryId, orgId } = bullJob.data;
      const attempt = bullJob.attemptsMade + 1;
      const result = await attemptDelivery(bullJob.data, opts.checkTarget ?? isSafeWebhookTarget);

      if (result.outcome === "retry") {
        await recordDeliveryAttempt(opts.db, orgId, deliveryId, attempt, result, false);
        throw new Error(result.errorMessage ?? "delivery failed, retrying");
      }

      await recordDeliveryAttempt(opts.db, orgId, deliveryId, attempt, result, true);
    },
    {
      prefix: WEBHOOK_QUEUE_PREFIX,
      connection: redis.duplicate({ maxRetriesPerRequest: null }),
      concurrency: opts.concurrency ?? 10,
      settings: {
        backoffStrategy: makeBackoffStrategy(opts.retryScheduleMs ?? WEBHOOK_RETRY_SCHEDULE_MS),
      },
    },
  );

  // Only fires once BullMQ's own attempts counter (WEBHOOK_MAX_ATTEMPTS,
  // set when the job was enqueued) is truly exhausted — never on an
  // in-progress retry, which the processor above already recorded as
  // PENDING and let BullMQ reschedule.
  worker.on("failed", (bullJob, err) => {
    if (!bullJob) return;
    const { deliveryId, orgId } = bullJob.data;
    const isFinalAttempt = bullJob.attemptsMade >= WEBHOOK_MAX_ATTEMPTS;
    if (!isFinalAttempt) return; // will retry — already recorded as PENDING
    void recordDeliveryAttempt(
      opts.db,
      orgId,
      deliveryId,
      bullJob.attemptsMade,
      { outcome: "retry", errorMessage: err.message },
      true,
    ).catch((writeErr: unknown) => opts.onError?.(writeErr));
  });

  if (opts.onError) worker.on("error", opts.onError);

  return worker;
}
