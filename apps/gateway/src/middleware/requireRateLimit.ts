import { rateLimitRejectedTotal } from "@cloudmesh/metrics";
import { tokenBucket } from "@cloudmesh/rate-limiter";
import { withSpan } from "@cloudmesh/telemetry";
import type { FastifyRequest } from "fastify";
import { RateLimitError } from "../errors.js";
import { emitRateLimitedEvent } from "../lib/platformEvents.js";

/**
 * Enforces api_keys.rate_limit_rpm (present since Phase 1, never actually
 * enforced until now) via the Token Bucket algorithm — the "production"
 * one per packages/rate-limiter's design notes: capacity = rpm (allows a
 * full-minute burst), refill = rpm/60 per second (smooth steady state
 * after that), rather than a hard per-minute cliff.
 *
 * Must run AFTER requireApiKey (needs request.apiKeyCtx). Deliberately
 * does not set X-RateLimit-* headers on the success path — the streaming
 * branch of the chat route calls reply.raw.writeHead() directly, which
 * would silently discard anything set via Fastify's normal reply.header()
 * here. The Retry-After header on the 429 path is unaffected by that,
 * since a thrown error here short-circuits before the route handler (and
 * any hijacking) ever runs.
 */
export async function requireRateLimit(request: FastifyRequest): Promise<void> {
  return withSpan("rate_limiter", {}, async (span) => {
    const ctx = request.apiKeyCtx!;
    const capacity = ctx.rateLimitRpm;
    const refillPerSecond = capacity / 60;

    const result = await tokenBucket(request.server.redis, ctx.apiKeyId, {
      capacity,
      refillPerSecond,
    });
    span.setAttribute("allowed", result.allowed);
    span.setAttribute("remaining", result.remaining);

    if (!result.allowed) {
      rateLimitRejectedTotal.inc({ org: ctx.orgId });
      const retryAfterSeconds = (result.resetAt - Date.now()) / 1000;

      // Awaited, not fire-and-forget: this repo has been bitten twice by
      // unawaited post-response work racing whatever the caller does next
      // (Phase 6's cache write, Phase 7's streaming bookkeeping). It's a
      // Redis SET that short-circuits on all but the first rejection in
      // the window, and it swallows its own errors, so it cannot fail or
      // meaningfully delay the 429.
      await emitRateLimitedEvent(request.server.redis, ctx.orgId, ctx.apiKeyId, retryAfterSeconds);

      throw new RateLimitError(retryAfterSeconds);
    }
  });
}
