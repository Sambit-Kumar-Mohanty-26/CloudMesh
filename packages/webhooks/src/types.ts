/**
 * Same BullMQ queue-naming constraint Phase 9 hit: `:` is illegal in a
 * queue name because BullMQ uses it as its own Redis key separator, so the
 * keyspace is expressed as prefix + name rather than one dotted string.
 * Both halves must be passed to every Queue AND Worker construction, or a
 * mismatch silently enqueues into a keyspace nothing drains.
 */
export const WEBHOOK_QUEUE_PREFIX = "cloudmesh";
export const WEBHOOK_QUEUE_NAME = "webhooks";

/**
 * The design doc's exact retry schedule: "5xx: retry w/ backoff (1s, 5s,
 * 30s, 5min, 30min)". A literal schedule, not a formula — expressed as a
 * custom BullMQ backoff strategy (see queue.ts) rather than `type:
 * "exponential"`, since 1s/5s/30s/5min/30min isn't a constant-ratio
 * exponential sequence (5x, 6x, 10x, 6x between consecutive steps).
 */
export const WEBHOOK_RETRY_SCHEDULE_MS = [1_000, 5_000, 30_000, 5 * 60_000, 30 * 60_000];
/** 1 initial attempt + 5 retries per the schedule above. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_SCHEDULE_MS.length + 1;

export interface WebhookJobData {
  deliveryId: string;
  orgId: string;
  endpointId: string;
  eventId: string;
  url: string;
  secret: string;
  eventType: string;
  payload: unknown;
}

/**
 * The design doc's event types. Six of the eight are real end to end —
 * `job.completed`/`job.failed` map to Phase 9's `Job.status`
 * COMPLETED/DEAD_LETTER, `budget.warning`/`budget.exceeded` to Phase 7's
 * budget checks, `api_key.created`/`api_key.revoked` to Phase 2's key
 * lifecycle, each published transactionally via the same outbox pattern as
 * `usage.recorded`.
 *
 * `request.rate_limited` and `provider.degraded` are valid, subscribable
 * schema values with NO live publisher wired this phase — see CLAUDE.md's
 * Phase 11 notes for the reasoning (in short: the rate limiter and circuit
 * breaker are hot-path Redis+Lua primitives with no org context and no
 * natural transaction to hang an outbox write on; wiring either for real
 * means adding a persistent NATS connection to a request-path middleware
 * used by nearly every test file, for a nice-to-have signal, not a
 * flagged-in-passing gap).
 */
export const WEBHOOK_EVENT_TYPES = [
  "job.completed",
  "job.failed",
  "budget.warning",
  "budget.exceeded",
  "api_key.created",
  "api_key.revoked",
  "request.rate_limited",
  "provider.degraded",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}
