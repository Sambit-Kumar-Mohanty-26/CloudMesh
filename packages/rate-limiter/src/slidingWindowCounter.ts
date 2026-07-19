import type { Redis } from "ioredis";
import type { RateLimitResult } from "./types.js";

// Weights the previous window's count by how much of the current window
// remains, approximating a true sliding window with two cheap counters
// instead of a full request log. Redis's Lua->reply conversion truncates
// non-integer numbers to integers, so the weighted value is returned as a
// string and parsed back to a float in TS — returning it as a bare number
// would silently lose precision.
const SCRIPT = `
local currKey = KEYS[1]
local prevKey = KEYS[2]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local elapsedFraction = tonumber(ARGV[3])

local curr = tonumber(redis.call("GET", currKey) or "0")
local prev = tonumber(redis.call("GET", prevKey) or "0")
local weighted = prev * (1 - elapsedFraction) + curr

local allowed = 0
if weighted < limit then
  curr = redis.call("INCR", currKey)
  if curr == 1 then
    redis.call("PEXPIRE", currKey, windowMs * 2)
  end
  allowed = 1
  weighted = weighted + 1
end

return {allowed, tostring(weighted)}
`;

export interface SlidingWindowCounterConfig {
  limit: number;
  windowMs: number;
}

/**
 * Sliding Window Counter — the practical middle ground between Fixed
 * Window (cheap, but bursts at boundaries) and Sliding Window Log (exact,
 * but stores every request). Two integer counters per identifier instead
 * of one, no unbounded growth.
 */
export async function slidingWindowCounter(
  redis: Redis,
  identifier: string,
  config: SlidingWindowCounterConfig,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const currWindowStart = Math.floor(now / config.windowMs) * config.windowMs;
  const prevWindowStart = currWindowStart - config.windowMs;
  const currKey = `ratelimit:slidingcounter:${identifier}:${currWindowStart}`;
  const prevKey = `ratelimit:slidingcounter:${identifier}:${prevWindowStart}`;
  const elapsedFraction = (now - currWindowStart) / config.windowMs;

  const [allowedFlag, weightedStr] = (await redis.eval(
    SCRIPT,
    2,
    currKey,
    prevKey,
    config.limit,
    config.windowMs,
    elapsedFraction,
  )) as [number, string];

  const weighted = parseFloat(weightedStr);
  return {
    allowed: allowedFlag === 1,
    remaining: Math.max(0, Math.floor(config.limit - weighted)),
    resetAt: currWindowStart + config.windowMs,
  };
}
