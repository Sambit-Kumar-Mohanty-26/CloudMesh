import { getAppPrisma, withTenant } from "@cloudmesh/db";
import { writeOutboxEvent } from "@cloudmesh/outbox";
import type { Redis } from "ioredis";

/**
 * Emits the two operational event types that shipped as schema-valid and
 * subscribable in Phase 11 but had no live publisher: `request.rate_limited`
 * and `provider.degraded`.
 *
 * Phase 11's stated objection to wiring these was that the rate limiter and
 * circuit breaker are hot-path Redis+Lua primitives with no org context and
 * no natural transaction to hang an outbox write on — wiring them "means
 * adding a persistent NATS connection to request-path middleware". Both
 * halves of that are addressed here rather than ignored:
 *
 *   - **No NATS in the request path.** This writes an `outbox_events` row
 *     (plain Postgres) exactly like every other event in this codebase.
 *     Phase 10's poller picks it up and publishes it. The request path
 *     never touches the broker.
 *   - **Org context comes from the caller, not the primitive.** These are
 *     called from `requireRateLimit` (which has `apiKeyCtx.orgId`) and from
 *     the chat route's provider-unavailable path (which has `orgId`), not
 *     from inside `packages/rate-limiter` or `packages/circuit-breaker`,
 *     which genuinely have no tenant to attribute anything to.
 *
 * **Both are deduped in Redis, and that is load-bearing, not tidiness.**
 * A rate-limited caller is by definition sending a lot of requests — one
 * DB write per rejected request would turn the rate limiter, whose entire
 * job is to shed load, into a write amplifier under exactly the abusive
 * traffic it exists to stop. `SET NX EX` means at most one event per org
 * (or per org+provider) per window no matter how hard someone hammers it.
 * A rejected request still always increments the Prometheus counter; only
 * the durable event is throttled.
 *
 * Every failure here is swallowed. These are advisory notifications — a
 * failed Redis dedupe check or a failed outbox insert must never turn a
 * 429 into a 500, or fail a request that was otherwise about to succeed.
 */

/** One event per org per minute for rate limiting, per org+provider per
 *  five minutes for degradation — a provider outage is a slower-moving
 *  signal than a burst of 429s and doesn't need per-minute granularity. */
const RATE_LIMITED_DEDUPE_SECONDS = 60;
const PROVIDER_DEGRADED_DEDUPE_SECONDS = 300;

/** Returns true if this caller won the dedupe slot for `key`. */
async function claimDedupeSlot(redis: Redis, key: string, ttlSeconds: number): Promise<boolean> {
  const claimed = await redis.set(key, "1", "EX", ttlSeconds, "NX");
  return claimed === "OK";
}

async function emit(orgId: string, eventType: string, payload: object): Promise<void> {
  const prisma = getAppPrisma();
  await withTenant(prisma, orgId, (tx) => writeOutboxEvent(tx, eventType, { orgId, ...payload }));
}

/**
 * Called from `requireRateLimit` when a request is rejected. `retryAfterSeconds`
 * is the same value sent in the Retry-After header, so a webhook consumer
 * sees exactly what the caller was told.
 */
export async function emitRateLimitedEvent(
  redis: Redis,
  orgId: string,
  apiKeyId: string,
  retryAfterSeconds: number,
): Promise<void> {
  try {
    if (!(await claimDedupeSlot(redis, `events:ratelimited:${orgId}`, RATE_LIMITED_DEDUPE_SECONDS)))
      return;

    await emit(orgId, "request.rate_limited", {
      apiKeyId,
      retryAfterSeconds,
      // Tells a consumer this represents a window, not a single request —
      // otherwise the dedupe above looks like dropped events.
      dedupeWindowSeconds: RATE_LIMITED_DEDUPE_SECONDS,
      occurredAt: new Date().toISOString(),
    });
  } catch {
    // Advisory only — never fail the 429 path.
  }
}

/**
 * Called when a provider is unavailable (its circuit is open, or every
 * candidate's circuit is open). Attributed to the org whose request
 * observed it: provider health is global (see Phase 8's note on
 * providerStats being shared), but webhook endpoints are per-org, so an
 * org can only be told about degradation its own traffic actually hit.
 * That's a real limitation of per-tenant delivery, not an oversight —
 * a fleet-wide alert belongs on the Phase 12 Grafana dashboards, which
 * already track `cloudmesh_circuit_breaker_state` for every provider.
 */
export async function emitProviderDegradedEvent(
  redis: Redis,
  orgId: string,
  provider: string,
  reason: string,
): Promise<void> {
  try {
    const key = `events:degraded:${orgId}:${provider}`;
    if (!(await claimDedupeSlot(redis, key, PROVIDER_DEGRADED_DEDUPE_SECONDS))) return;

    await emit(orgId, "provider.degraded", {
      provider,
      reason,
      dedupeWindowSeconds: PROVIDER_DEGRADED_DEDUPE_SECONDS,
      occurredAt: new Date().toISOString(),
    });
  } catch {
    // Advisory only — never turn a 503 into a 500.
  }
}
