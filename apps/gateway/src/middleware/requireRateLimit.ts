import { tokenBucket } from "@cloudmesh/rate-limiter";
import type { FastifyRequest } from "fastify";
import { RateLimitError } from "../errors.js";

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
  const ctx = request.apiKeyCtx!;
  const capacity = ctx.rateLimitRpm;
  const refillPerSecond = capacity / 60;

  const result = await tokenBucket(request.server.redis, ctx.apiKeyId, {
    capacity,
    refillPerSecond,
  });

  if (!result.allowed) {
    throw new RateLimitError((result.resetAt - Date.now()) / 1000);
  }
}
