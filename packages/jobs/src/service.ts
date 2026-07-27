import { withTenant, type JobStatus, type PrismaClient } from "@cloudmesh/db";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { normalizeProgress, publishJobProgress } from "./progress.js";
import { toPriorityValue, type JobData } from "./types.js";

/** Design doc: "Retry: 3 attempts → Dead Letter Queue". */
export const MAX_JOB_ATTEMPTS = 3;

export interface CreateJobInput {
  orgId: string;
  type: string;
  payload: unknown;
  priority?: unknown;
}

export interface CreatedJob {
  id: string;
  status: JobStatus;
  type: string;
  priority: number;
}

/**
 * Inserts the tenant-scoped `jobs` row FIRST, then enqueues to BullMQ.
 *
 * Order matters and isn't arbitrary: if the enqueue fails after the row
 * exists, the caller sees a QUEUED job that never runs — visible, and
 * recoverable via the same replay path the DLQ uses. The reverse order
 * risks a job executing with no row to write results to, which under RLS
 * the worker couldn't even repair. A stuck-but-visible row beats an
 * orphaned execution. (Same reasoning as Phase 7's insert-then-process
 * ordering for Stripe webhooks.)
 */
export async function createJob(
  db: PrismaClient,
  queue: Queue<JobData>,
  input: CreateJobInput,
): Promise<CreatedJob> {
  const priority = toPriorityValue(input.priority);

  const row = await withTenant(db, input.orgId, (tx) =>
    tx.job.create({
      data: {
        orgId: input.orgId,
        type: input.type,
        priority,
        payload: input.payload as never,
      },
      select: { id: true, status: true, type: true, priority: true },
    }),
  );

  const bullJob = await queue.add(
    input.type,
    { jobRecordId: row.id, orgId: input.orgId, type: input.type },
    {
      priority,
      attempts: MAX_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: 1000 },
      // Keep finished jobs out of Redis — Postgres is the system of record
      // and unbounded completed/failed sets are a well-known BullMQ memory
      // leak. Failures are preserved in the jobs row (status + error), so
      // nothing diagnostic is lost by letting Redis drop them.
      removeOnComplete: true,
      removeOnFail: true,
    },
  );

  await withTenant(db, input.orgId, (tx) =>
    tx.job.update({ where: { id: row.id }, data: { bullJobId: bullJob.id } }),
  );

  return row;
}

/** Tenant-scoped read. RLS makes another org's job invisible rather than
 *  forbidden, so a cross-tenant id returns null and the route turns that
 *  into a 404 — never confirming that someone else's job id exists. */
export async function getJob(db: PrismaClient, orgId: string, jobId: string) {
  return withTenant(db, orgId, (tx) => tx.job.findFirst({ where: { id: jobId, orgId } }));
}

export async function listJobs(
  db: PrismaClient,
  orgId: string,
  opts: { status?: JobStatus; limit?: number } = {},
) {
  return withTenant(db, orgId, (tx) =>
    tx.job.findMany({
      where: { orgId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: { createdAt: "desc" },
      take: Math.min(opts.limit ?? 50, 200),
    }),
  );
}

export async function markJobRunning(
  db: PrismaClient,
  redis: Redis,
  jobRecordId: string,
  orgId: string,
  attempt: number,
): Promise<void> {
  await withTenant(db, orgId, (tx) =>
    tx.job.updateMany({
      where: { id: jobRecordId, orgId },
      data: { status: "RUNNING", attempts: attempt, startedAt: new Date(), progress: 0 },
    }),
  );
  await publishJobProgress(redis, { jobId: jobRecordId, progress: 0, status: "RUNNING" });
}

/**
 * Each progress report is its own short transaction, NOT one transaction
 * held open for the job's lifetime. A job can legitimately run for minutes
 * (that's the whole point of this phase), and pinning a Postgres connection
 * and an open transaction for that long would exhaust the pool under any
 * real concurrency — the same hazard, for the same reason, as Phase 7's
 * decision not to hold the billing lock across a provider call.
 */
export async function updateJobProgress(
  db: PrismaClient,
  redis: Redis,
  jobRecordId: string,
  orgId: string,
  percent: number,
): Promise<void> {
  const progress = normalizeProgress(percent);
  await withTenant(db, orgId, (tx) =>
    tx.job.updateMany({ where: { id: jobRecordId, orgId }, data: { progress } }),
  );
  await publishJobProgress(redis, { jobId: jobRecordId, progress, status: "RUNNING" });
}

export async function markJobCompleted(
  db: PrismaClient,
  redis: Redis,
  jobRecordId: string,
  orgId: string,
  result: unknown,
): Promise<void> {
  await withTenant(db, orgId, (tx) =>
    tx.job.updateMany({
      where: { id: jobRecordId, orgId },
      data: {
        status: "COMPLETED",
        progress: 100,
        result: (result ?? null) as never,
        finishedAt: new Date(),
        error: null,
      },
    }),
  );
  await publishJobProgress(redis, { jobId: jobRecordId, progress: 100, status: "COMPLETED" });
}

/**
 * `isFinalAttempt` decides FAILED vs DEAD_LETTER: BullMQ will retry a
 * failed job until `attempts` is exhausted, so only the last one is
 * genuinely dead. Marking earlier attempts DEAD_LETTER would put jobs in
 * the DLQ review queue that the queue itself is about to retry
 * successfully.
 */
export async function markJobFailed(
  db: PrismaClient,
  redis: Redis,
  jobRecordId: string,
  orgId: string,
  message: string,
  isFinalAttempt: boolean,
): Promise<void> {
  const status: JobStatus = isFinalAttempt ? "DEAD_LETTER" : "FAILED";
  await withTenant(db, orgId, (tx) =>
    tx.job.updateMany({
      where: { id: jobRecordId, orgId },
      data: { status, error: message, ...(isFinalAttempt ? { finishedAt: new Date() } : {}) },
    }),
  );
  await publishJobProgress(redis, { jobId: jobRecordId, progress: 0, status, error: message });
}

export class JobNotReplayableError extends Error {
  constructor(status: JobStatus) {
    super(`Only DEAD_LETTER jobs can be replayed (job is ${status})`);
    this.name = "JobNotReplayableError";
  }
}

/**
 * The design doc's "DLQ: manual review + replay". Re-enqueues an exhausted
 * job against its ORIGINAL row rather than creating a new one, so a job's
 * history (attempt count, original payload, the error that killed it) stays
 * in one place instead of fragmenting across a chain of retry copies.
 *
 * Restricted to DEAD_LETTER on purpose: replaying a RUNNING or QUEUED job
 * would put two live executions on the same row, racing each other's
 * status writes.
 */
export async function replayJob(
  db: PrismaClient,
  queue: Queue<JobData>,
  orgId: string,
  jobId: string,
): Promise<void> {
  const job = await getJob(db, orgId, jobId);
  if (!job) return; // caller turns this into a 404
  if (job.status !== "DEAD_LETTER") {
    throw new JobNotReplayableError(job.status);
  }

  await withTenant(db, orgId, (tx) =>
    tx.job.update({
      where: { id: job.id },
      data: {
        status: "QUEUED",
        error: null,
        progress: 0,
        attempts: 0,
        startedAt: null,
        finishedAt: null,
      },
    }),
  );

  const bullJob = await queue.add(
    job.type,
    { jobRecordId: job.id, orgId, type: job.type },
    {
      priority: job.priority,
      attempts: MAX_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  );

  await withTenant(db, orgId, (tx) =>
    tx.job.update({ where: { id: job.id }, data: { bullJobId: bullJob.id } }),
  );
}
