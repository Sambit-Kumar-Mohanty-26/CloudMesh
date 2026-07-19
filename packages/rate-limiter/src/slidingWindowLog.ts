import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { RateLimitResult } from "./types.js";

// A sorted set of individual request timestamps. Trim anything older than
// the window, count what's left, and (atomically, in the same script) add
// the new entry only if under the limit — so the count-then-add can't race
// against a concurrent caller doing the same thing.
const SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call("ZREMRANGEBYSCORE", key, 0, now - windowMs)
local count = redis.call("ZCARD", key)

local allowed = 0
if count < limit then
  redis.call("ZADD", key, now, member)
  redis.call("PEXPIRE", key, windowMs)
  allowed = 1
  count = count + 1
end

return {allowed, count}
`;

export interface SlidingWindowLogConfig {
  limit: number;
  windowMs: number;
}

/**
 * Sliding Window Log — the most accurate of the four (no boundary-burst
 * problem: the window truly slides continuously), at the cost of storing
 * one sorted-set entry per request in the window rather than a single
 * counter. Reasonable for per-org/per-key limits at moderate request
 * volume; not what you'd pick for a very high-QPS global limit.
 */
export async function slidingWindowLog(
  redis: Redis,
  identifier: string,
  config: SlidingWindowLogConfig,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const key = `ratelimit:slidinglog:${identifier}`;
  // Timestamp alone isn't unique enough — two requests in the same
  // millisecond would otherwise collide as the same ZSET member and only
  // count once.
  const member = `${now}-${randomUUID()}`;

  const [allowedFlag, count] = (await redis.eval(
    SCRIPT,
    1,
    key,
    now,
    config.windowMs,
    config.limit,
    member,
  )) as [number, number];

  return {
    allowed: allowedFlag === 1,
    remaining: Math.max(0, config.limit - count),
    resetAt: now + config.windowMs,
  };
}
