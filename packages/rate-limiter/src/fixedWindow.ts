import type { Redis } from "ioredis";
import type { RateLimitResult } from "./types.js";

// INCR + PEXPIRE happen atomically inside Redis's single-threaded Lua
// execution — this is what actually prevents the race that a naive
// GET-then-SET from application code would have across concurrent callers
// on different backend instances (the whole point of "distributed").
const SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local limit = tonumber(ARGV[2])
local allowed = 0
if current <= limit then
  allowed = 1
end
return {allowed, current}
`;

export interface FixedWindowConfig {
  limit: number;
  windowMs: number;
}

/**
 * Fixed Window Counter — simplest of the four. One counter per
 * (identifier, window), reset each window boundary.
 *
 * Known weakness (why Sliding Window Counter exists): a burst straddling a
 * window boundary can let up to ~2x the limit through in a short span —
 * e.g. `limit` requests land at 0:59, then `limit` more at 1:00, both
 * "within limit" per their own window despite being ~seconds apart.
 */
export async function fixedWindow(
  redis: Redis,
  identifier: string,
  config: FixedWindowConfig,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const windowStart = Math.floor(now / config.windowMs) * config.windowMs;
  const key = `ratelimit:fixed:${identifier}:${windowStart}`;

  const [allowedFlag, current] = (await redis.eval(
    SCRIPT,
    1,
    key,
    config.windowMs,
    config.limit,
  )) as [number, number];

  return {
    allowed: allowedFlag === 1,
    remaining: Math.max(0, config.limit - current),
    resetAt: windowStart + config.windowMs,
  };
}
