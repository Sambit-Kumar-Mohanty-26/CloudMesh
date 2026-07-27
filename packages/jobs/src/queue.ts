import { getAppPrisma, withTenant, type PrismaClient } from "@cloudmesh/db";
import { Queue, Worker, type Job as BullJob } from "bullmq";
import type { Redis } from "ioredis";
import {
  markJobCompleted,
  markJobFailed,
  markJobRunning,
  updateJobProgress,
  MAX_JOB_ATTEMPTS,
} from "./service.js";
import { JOB_QUEUE_NAME, JOB_QUEUE_PREFIX, type JobData, type JobRegistry } from "./types.js";

/** Design doc: "Concurrency: 10 workers per queue". */
export const DEFAULT_WORKER_CONCURRENCY = 10;
/** Design doc: "Visibility timeout: 5 min" — BullMQ's equivalent is
 *  lockDuration, after which an unrenewed job is considered stalled and
 *  handed to another worker. */
export const DEFAULT_LOCK_DURATION_MS = 5 * 60_000;

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it uses
 * for blocking commands; ioredis' default of 20 makes long BRPOPLPUSH waits
 * throw. Rather than mutate the app's shared Redis client (which the rate
 * limiter, circuit breaker, and cache all share and which must keep its own
 * retry semantics), BullMQ gets its own duplicated connection.
 */
export function createJobQueue(redis: Redis): Queue<JobData> {
  return new Queue<JobData>(JOB_QUEUE_NAME, {
    prefix: JOB_QUEUE_PREFIX,
    connection: redis.duplicate({ maxRetriesPerRequest: null }),
  });
}

export interface WorkerOptions {
  concurrency?: number;
  lockDurationMs?: number;
  onError?: (err: unknown) => void;
  /** Injectable so tests can use their own client; defaults to the shared
   *  process-wide app (RLS-bound) client. */
  db?: PrismaClient;
}

/**
 * The worker pool. Every job runs through the same lifecycle:
 * mark RUNNING -> handler (reporting progress) -> mark COMPLETED, or on a
 * throw, mark FAILED / DEAD_LETTER depending on whether BullMQ has retries
 * left.
 *
 * The worker drains jobs for EVERY org, so it must never query `jobs`
 * unscoped — each status write goes through `withTenant` with the org id
 * carried in the job's own data (see JobData). It connects as the same
 * RLS-bound `cloudmesh_app` role as the HTTP path, not the admin role.
 */
export function createJobWorker(
  redis: Redis,
  registry: JobRegistry,
  opts: WorkerOptions = {},
): Worker<JobData> {
  const db = opts.db ?? getAppPrisma();
  // Progress publishing and status writes need a normal (non-blocking)
  // Redis client; the worker's own connection is busy blocking on the queue.
  const pubRedis = redis;

  const worker = new Worker<JobData>(
    JOB_QUEUE_NAME,
    async (bullJob: BullJob<JobData>) => {
      const { jobRecordId, orgId, type } = bullJob.data;
      const attempt = bullJob.attemptsMade + 1;

      await markJobRunning(db, pubRedis, jobRecordId, orgId, attempt);

      const handler = registry.get(type);
      // MUST be tenant-scoped: the worker connects as the RLS-bound
      // cloudmesh_app role, so an unscoped findUnique here returns nothing
      // at all (the policy hides the row rather than erroring) and every
      // job would run against a null payload.
      const row = await withTenant(db, orgId, (tx) =>
        tx.job.findFirst({ where: { id: jobRecordId, orgId }, select: { payload: true } }),
      );
      if (!row) {
        throw new Error(`Job record ${jobRecordId} not found for org`);
      }
      const payload = row.payload;

      const result = await handler.run(handler.parsePayload(payload) as never, {
        jobRecordId,
        orgId,
        reportProgress: (percent: number) =>
          updateJobProgress(db, pubRedis, jobRecordId, orgId, percent),
      });

      await markJobCompleted(db, pubRedis, jobRecordId, orgId, result);
      return result;
    },
    {
      // Must match createJobQueue's prefix exactly — a mismatch means
      // producer and consumer use different Redis keyspaces and jobs are
      // enqueued into a queue nothing is listening on.
      prefix: JOB_QUEUE_PREFIX,
      connection: redis.duplicate({ maxRetriesPerRequest: null }),
      concurrency: opts.concurrency ?? DEFAULT_WORKER_CONCURRENCY,
      lockDuration: opts.lockDurationMs ?? DEFAULT_LOCK_DURATION_MS,
    },
  );

  worker.on("failed", (bullJob, err) => {
    if (!bullJob) return;
    const { jobRecordId, orgId } = bullJob.data;
    const isFinalAttempt = bullJob.attemptsMade >= MAX_JOB_ATTEMPTS;
    // Only the error's message, never the error object — a handler wrapping
    // a provider call can carry prompt/response text in its stack or cause
    // chain (same rule as the semantic cache's catch in apps/gateway).
    const message = err instanceof Error ? err.message : "job failed";

    void markJobFailed(db, pubRedis, jobRecordId, orgId, message, isFinalAttempt).catch(
      (writeErr: unknown) => opts.onError?.(writeErr),
    );
  });

  if (opts.onError) worker.on("error", opts.onError);

  return worker;
}
