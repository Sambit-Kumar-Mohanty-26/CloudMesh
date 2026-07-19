import type { Redis } from "ioredis";
import type { RateLimitResult } from "./types.js";

// Lazily refills on read rather than needing a background job: each call
// computes how many tokens should have accrued since last_refill, caps at
// capacity, then attempts to spend `requested`. The read-refill-spend-write
// sequence is one atomic Lua execution, so two concurrent requests can't
// both read the same token count and both succeed when only one should.
const SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSecond = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local bucket = redis.call("HMGET", key, "tokens", "last_refill")
local tokens = tonumber(bucket[1])
local lastRefill = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  lastRefill = now
end

local elapsedSeconds = math.max(0, (now - lastRefill) / 1000)
tokens = math.min(capacity, tokens + elapsedSeconds * refillPerSecond)

local allowed = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
end

redis.call("HMSET", key, "tokens", tostring(tokens), "last_refill", tostring(now))
local ttlSeconds = math.ceil(capacity / refillPerSecond) + 60
redis.call("EXPIRE", key, ttlSeconds)

return {allowed, tostring(tokens)}
`;

export interface TokenBucketConfig {
  capacity: number;
  refillPerSecond: number;
  /** Tokens this call costs. Defaults to 1 — a per-endpoint limiter could
   *  pass a higher cost for expensive operations. */
  requested?: number;
}

/**
 * Token Bucket — the production algorithm (see registry.ts callers).
 * Allows a burst up to `capacity`, then a smooth steady-state rate of
 * `refillPerSecond`, rather than the hard reset-at-boundary behavior of
 * the window algorithms. This is what apps/gateway enforces per API key,
 * using api_keys.rate_limit_rpm as capacity.
 */
export async function tokenBucket(
  redis: Redis,
  identifier: string,
  config: TokenBucketConfig,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const key = `ratelimit:tokenbucket:${identifier}`;
  const requested = config.requested ?? 1;

  const [allowedFlag, tokensStr] = (await redis.eval(
    SCRIPT,
    1,
    key,
    config.capacity,
    config.refillPerSecond,
    now,
    requested,
  )) as [number, string];

  const tokens = parseFloat(tokensStr);
  const deficit = Math.max(0, requested - tokens);
  const resetAt = now + (deficit / config.refillPerSecond) * 1000;

  return {
    allowed: allowedFlag === 1,
    remaining: Math.floor(tokens),
    resetAt,
  };
}
