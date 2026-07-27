import { z } from "zod";

/**
 * The stream every CloudMesh platform event lands in. One stream with
 * subject-based filtering, not one stream per event type: JetStream
 * consumers filter by subject natively, and a stream per type would
 * multiply retention/replica config with no gain.
 */
export const EVENT_STREAM_NAME = "CLOUDMESH_EVENTS";
/** `cloudmesh.>` captures every subject below the root, so a new event type
 *  needs no stream reconfiguration — only a consumer that filters for it. */
export const EVENT_SUBJECT_PREFIX = "cloudmesh";
export const EVENT_SUBJECT_WILDCARD = `${EVENT_SUBJECT_PREFIX}.>`;

/**
 * Event types carried on the bus. `request.completed` is the design doc's
 * headline event; the rest are the ones Phase 7's outbox already writes
 * (`usage.recorded`, `budget.warning`), kept as their existing names so the
 * outbox rows written before this phase still map to valid subjects.
 */
export const EVENT_TYPES = ["request.completed", "usage.recorded", "budget.warning"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export function isKnownEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

/** `usage.recorded` -> `cloudmesh.usage.recorded`. Subjects mirror the event
 *  type exactly so a consumer's filter is readable against the type name. */
export function subjectFor(eventType: string): string {
  return `${EVENT_SUBJECT_PREFIX}.${eventType}`;
}

/**
 * The design doc's event schema, with the fields it lists. Everything the
 * subscribers actually branch on is required; `latency_ms`/`cache_hit` are
 * optional because Phase 7's existing outbox writers don't record them and
 * back-filling old rows isn't possible.
 *
 * Validated on the CONSUMER side, not just the producer: a malformed or
 * hand-injected message must be rejected by the subscriber rather than
 * crashing it or writing garbage downstream.
 */
export const requestCompletedSchema = z.object({
  orgId: z.string().uuid(),
  requestId: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().int().nonnegative().optional(),
  cacheHit: z.boolean().optional(),
});
export type RequestCompletedEvent = z.infer<typeof requestCompletedSchema>;

export const usageRecordedSchema = z.object({
  orgId: z.string().uuid(),
  apiKeyId: z.string().uuid(),
  model: z.string().min(1).max(200),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  requestId: z.string().min(1).max(200),
});
export type UsageRecordedEvent = z.infer<typeof usageRecordedSchema>;

export const budgetWarningSchema = z.object({
  orgId: z.string().uuid(),
  spentUsd: z.number().nonnegative(),
  budgetUsd: z.number().nonnegative().nullable(),
  remainingFraction: z.number(),
});
export type BudgetWarningEvent = z.infer<typeof budgetWarningSchema>;

/** The envelope every message on the bus carries. `eventId` is what makes
 *  at-least-once delivery safe to consume: a redelivered message has the
 *  same id, so an idempotent subscriber can skip it (see the audit
 *  subscriber's unique constraint). */
export const eventEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(200),
  eventType: z.string().min(1).max(100),
  timestamp: z.string().min(1),
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

const PAYLOAD_SCHEMAS = {
  "request.completed": requestCompletedSchema,
  "usage.recorded": usageRecordedSchema,
  "budget.warning": budgetWarningSchema,
} as const;

export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEventError";
  }
}

/**
 * Parses a raw message into a validated envelope + payload. Throws
 * InvalidEventError on anything malformed — subscribers turn that into a
 * TERM (don't redeliver) rather than a NAK, since a message that fails
 * schema validation will fail identically on every retry and would
 * otherwise redeliver forever.
 */
export function parseEvent(raw: unknown): { envelope: EventEnvelope; payload: unknown } {
  const envelope = eventEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new InvalidEventError(envelope.error.issues[0]?.message ?? "Malformed event envelope");
  }

  const schema = PAYLOAD_SCHEMAS[envelope.data.eventType as keyof typeof PAYLOAD_SCHEMAS];
  if (!schema) {
    // An unknown event type is not an error — a newer producer may emit
    // types this consumer doesn't handle yet. The envelope is still valid;
    // the caller decides whether to act on it.
    return { envelope: envelope.data, payload: envelope.data.payload };
  }

  const payload = schema.safeParse(envelope.data.payload);
  if (!payload.success) {
    throw new InvalidEventError(
      `Invalid ${envelope.data.eventType} payload: ${payload.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return { envelope: envelope.data, payload: payload.data };
}
