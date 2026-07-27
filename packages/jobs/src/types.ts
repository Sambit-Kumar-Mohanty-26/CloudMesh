/** The design doc's exact priority scale. Lower number = higher priority,
 *  which is also BullMQ's own convention, so these map straight through to
 *  `priority` on the queue without translation. */
export const JOB_PRIORITIES = {
  CRITICAL: 1,
  HIGH: 5,
  NORMAL: 10,
  LOW: 20,
} as const;

export type JobPriorityName = keyof typeof JOB_PRIORITIES;

export const DEFAULT_PRIORITY: JobPriorityName = "NORMAL";

export function isJobPriorityName(value: unknown): value is JobPriorityName {
  return typeof value === "string" && value in JOB_PRIORITIES;
}

/** Coerces a caller-supplied priority to a real one, falling back to NORMAL
 *  rather than throwing — same defensive-coercion convention as Phase 8's
 *  routing_preset (lib/featureFlags.ts). */
export function toPriorityValue(name: unknown): number {
  return JOB_PRIORITIES[isJobPriorityName(name) ? name : DEFAULT_PRIORITY];
}

/**
 * The design doc names the queue `cloudmesh:jobs`, but BullMQ rejects `:`
 * in a queue name outright ("Queue name cannot contain :") because it uses
 * `:` as its own Redis key separator. Splitting it into prefix + name
 * produces exactly the keyspace the doc describes — Redis keys really are
 * `cloudmesh:jobs:*` — while staying within BullMQ's naming rule. Both
 * halves must be passed together everywhere a Queue or Worker is
 * constructed, or the producer and consumer silently use different
 * keyspaces and no job is ever picked up.
 *
 * One queue with a priority field, not one queue per priority: BullMQ
 * orders by priority within a queue natively, whereas separate queues would
 * each need their own worker pool and could starve one another.
 */
export const JOB_QUEUE_PREFIX = "cloudmesh";
export const JOB_QUEUE_NAME = "jobs";

/** Data BullMQ carries for each job. Deliberately small — the authoritative
 *  payload/result live in the `jobs` Postgres row (see schema.prisma's Job
 *  model for why both exist). `orgId` rides along because the worker needs
 *  it to set `app.current_org` BEFORE it can legally read that row under
 *  RLS; it can't look the org up from the row first. */
export interface JobData {
  /** The `jobs.id` UUID — the Postgres row this queue entry corresponds to. */
  jobRecordId: string;
  orgId: string;
  type: string;
}

export interface JobHandlerContext {
  jobRecordId: string;
  orgId: string;
  /** Reports 0-100 progress: persists to the jobs row and publishes to
   *  Redis pub/sub for the WebSocket bridge. */
  reportProgress: (percent: number) => Promise<void>;
}

/** A job type's implementation. Registered in a JobRegistry so the queue
 *  stays generic — adding a job type never means touching the worker or
 *  the routes. */
export interface JobHandler<TPayload = unknown, TResult = unknown> {
  type: string;
  /** Validates and narrows a caller-supplied payload. Throws on invalid
   *  input; the route turns that into a 400 before anything is enqueued,
   *  so a malformed job never reaches the queue at all. */
  parsePayload: (raw: unknown) => TPayload;
  run: (payload: TPayload, ctx: JobHandlerContext) => Promise<TResult>;
}

export class UnknownJobTypeError extends Error {
  constructor(public readonly type: string) {
    super(`Unknown job type: ${type}`);
    this.name = "UnknownJobTypeError";
  }
}

export class JobRegistry {
  private readonly handlers = new Map<string, JobHandler<never, unknown>>();

  register<TPayload, TResult>(handler: JobHandler<TPayload, TResult>): this {
    this.handlers.set(handler.type, handler as unknown as JobHandler<never, unknown>);
    return this;
  }

  get(type: string): JobHandler<never, unknown> {
    const handler = this.handlers.get(type);
    if (!handler) throw new UnknownJobTypeError(type);
    return handler;
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }
}
