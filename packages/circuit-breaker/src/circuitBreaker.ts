import type { Redis } from "ioredis";
import { CircuitOpenError, type CircuitBreakerConfig, type CircuitState } from "./types.js";

const TTL_SECONDS = 3600; // breaker state is cheap to lose and re-derive from scratch (closed)

function key(name: string): string {
  return `circuit:${name}`;
}

// Decides whether THIS caller may proceed, and atomically claims the
// single half-open "probe" slot if this is the request that gets to test
// recovery — without the atomicity, two concurrent callers could both see
// "time to probe" and both go through, defeating the point of half-open.
const ATTEMPT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local failureWindowMs = tonumber(ARGV[2])
local openDurationMs = tonumber(ARGV[3])

local data = redis.call("HMGET", key, "state", "windowStart", "openedAt", "probeTaken")
local state = data[1] or "closed"
local openedAt = tonumber(data[3]) or 0
local probeTaken = data[4]

if state == "closed" then
  if data[2] == false then
    -- First time this circuit has ever been touched — establish the
    -- window start now. Without this, windowStart only ever existed as a
    -- Lua-local default (equal to "now" on every single call), so the
    -- elapsed-time check below could never observe real elapsed time.
    redis.call("HSET", key, "windowStart", now)
  elseif (now - tonumber(data[2])) > failureWindowMs then
    redis.call("HMSET", key, "failures", 0, "windowStart", now)
  end
  return {1, "closed"}
end

if state == "open" then
  if (now - openedAt) >= openDurationMs then
    redis.call("HMSET", key, "state", "half_open", "probeTaken", "1")
    redis.call("EXPIRE", key, ${TTL_SECONDS})
    return {1, "half_open"}
  end
  return {0, "open"}
end

-- half_open
if probeTaken == "1" then
  return {0, "half_open"}
end
redis.call("HSET", key, "probeTaken", "1")
return {1, "half_open"}
`;

// Records the real outcome of a call this function already allowed through
// ATTEMPT_SCRIPT. Separate script (rather than folding into ATTEMPT_SCRIPT)
// because the outcome is only known after fn() actually runs.
const REPORT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local success = tonumber(ARGV[2])
local failureThreshold = tonumber(ARGV[3])

local data = redis.call("HMGET", key, "state", "failures")
local state = data[1] or "closed"
local failures = tonumber(data[2]) or 0

if success == 1 then
  if state == "half_open" then
    redis.call("HMSET", key, "state", "closed", "failures", 0, "windowStart", now, "probeTaken", "0")
    redis.call("EXPIRE", key, ${TTL_SECONDS})
    return "closed"
  end
  return state
end

-- failure
if state == "half_open" then
  redis.call("HMSET", key, "state", "open", "openedAt", now, "probeTaken", "0")
  redis.call("EXPIRE", key, ${TTL_SECONDS})
  return "open"
end

failures = failures + 1
if failures >= failureThreshold then
  redis.call("HMSET", key, "state", "open", "openedAt", now, "failures", failures)
  redis.call("EXPIRE", key, ${TTL_SECONDS})
  return "open"
end
redis.call("HMSET", key, "failures", failures)
redis.call("EXPIRE", key, ${TTL_SECONDS})
return "closed"
`;

/** Read-only peek at current state — does NOT claim the half-open probe
 *  slot. Used to pick which candidate to attempt (e.g. provider fallback)
 *  without committing to it; the real, authoritative gate is still
 *  withCircuitBreaker's own atomic check at call time. */
export async function getCircuitState(redis: Redis, name: string): Promise<CircuitState> {
  const state = await redis.hget(key(name), "state");
  return (state as CircuitState | null) ?? "closed";
}

/** Test/ops utility — force a circuit back to closed. */
export async function resetCircuit(redis: Redis, name: string): Promise<void> {
  await redis.del(key(name));
}

/** Test/ops utility — force a circuit open, e.g. for an on-call engineer
 *  to manually stop traffic to a provider known to be down without
 *  waiting for enough organic failures to trip it naturally. */
export async function forceOpenCircuit(
  redis: Redis,
  name: string,
  now: number = Date.now(),
): Promise<void> {
  await redis.hset(key(name), { state: "open", openedAt: now, probeTaken: "0" });
  await redis.expire(key(name), TTL_SECONDS);
}

/**
 * Wraps `fn` with the three-state circuit breaker described in the Phase 5
 * design doc: CLOSED (normal) -> OPEN (fail fast) after `failureThreshold`
 * failures in `failureWindowMs`, -> HALF_OPEN (exactly one probe request)
 * after `openDurationMs`, -> CLOSED on a successful probe or back to OPEN
 * on a failed one.
 *
 * Throws CircuitOpenError without calling `fn` at all when the circuit is
 * open (or when another concurrent caller already claimed the half-open
 * probe) — that's the entire point: stop hammering a known-failing
 * dependency instead of letting every request pay its timeout.
 */
export async function withCircuitBreaker<T>(
  redis: Redis,
  name: string,
  config: CircuitBreakerConfig,
  fn: () => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  const [allowed] = (await redis.eval(
    ATTEMPT_SCRIPT,
    1,
    key(name),
    now,
    config.failureWindowMs,
    config.openDurationMs,
  )) as [number, CircuitState];

  if (allowed !== 1) {
    throw new CircuitOpenError(name);
  }

  try {
    const result = await fn();
    await redis.eval(REPORT_SCRIPT, 1, key(name), now, 1, config.failureThreshold);
    return result;
  } catch (err) {
    await redis.eval(REPORT_SCRIPT, 1, key(name), now, 0, config.failureThreshold);
    throw err;
  }
}
