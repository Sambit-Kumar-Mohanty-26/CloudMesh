import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

export interface ProviderStats {
  /** Number of samples the current window has — 0 means "no data yet,"
   *  which callers must treat as neutral (see routingScoring.ts), not as
   *  a real 0ms/0% reading. */
  sampleCount: number;
  p50Ms: number;
  p99Ms: number;
  successRate: number;
  /** Requests to this provider in the last 60s specifically — the spec's
   *  literal "rpm_current" — computed from the same window as everything
   *  else, just counted over a tighter, fixed sub-range. */
  rpmCurrent: number;
}

const STATS_WINDOW_MS = 5 * 60_000; // 5 minutes — long enough for p50/p99 to mean something, short enough to reflect "right now"
const RPM_WINDOW_MS = 60_000;

function statsKey(provider: string): string {
  return `routing:stats:${provider}`;
}

// Atomic record-and-trim: a plain ZADD followed by a separate
// ZREMRANGEBYSCORE from the client would let two concurrent callers each
// see a not-yet-trimmed set and do redundant/racy trimming — harmless here
// since trimming is idempotent, but doing both in one round trip (and one
// guaranteed-atomic step) is free and matches this codebase's established
// Redis+Lua rigor for anything shared across concurrent requests.
const RECORD_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local member = ARGV[3]
redis.call("ZADD", key, now, member)
redis.call("ZREMRANGEBYSCORE", key, "-inf", now - windowMs)
redis.call("PEXPIRE", key, windowMs)
return 1
`;

/** Records one completed provider call's outcome — latency in ms and
 *  whether it ultimately succeeded (after any internal retries; see
 *  lib/resilience.ts). Provider stats are global, not per-org: "how fast
 *  is OpenAI right now" is a fact about the provider's real-world
 *  behavior across all traffic this gateway sends it, not a per-tenant
 *  measurement — every org's calls to the same provider contribute to the
 *  same shared window. */
export async function recordProviderOutcome(
  redis: Redis,
  provider: string,
  latencyMs: number,
  success: boolean,
  now: number = Date.now(),
): Promise<void> {
  // member must be unique per sample (ZADD dedupes by member, not score) —
  // two calls landing in the same millisecond with identical latency must
  // still both be recorded, not silently collapsed into one.
  const member = `${now}:${Math.round(latencyMs)}:${success ? 1 : 0}:${randomUUID()}`;
  await redis.eval(
    RECORD_SCRIPT,
    1,
    statsKey(provider),
    String(now),
    String(STATS_WINDOW_MS),
    member,
  );
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export async function getProviderStats(
  redis: Redis,
  provider: string,
  now: number = Date.now(),
): Promise<ProviderStats> {
  const key = statsKey(provider);
  // Trim first so a long-idle provider's stale samples (past the window,
  // but never touched by a fresh ZADD to trigger the record-script's own
  // trim) don't linger in a read.
  await redis.zremrangebyscore(key, "-inf", now - STATS_WINDOW_MS);
  const members = await redis.zrange(key, 0, -1);

  if (members.length === 0) {
    return { sampleCount: 0, p50Ms: 0, p99Ms: 0, successRate: 0, rpmCurrent: 0 };
  }

  const latencies: number[] = [];
  let successes = 0;
  let rpmCount = 0;
  for (const member of members) {
    const [tsStr, latStr, successStr] = member.split(":");
    const ts = Number(tsStr);
    latencies.push(Number(latStr));
    if (successStr === "1") successes++;
    if (now - ts <= RPM_WINDOW_MS) rpmCount++;
  }
  latencies.sort((a, b) => a - b);

  return {
    sampleCount: members.length,
    p50Ms: percentile(latencies, 50),
    p99Ms: percentile(latencies, 99),
    successRate: successes / members.length,
    rpmCurrent: rpmCount,
  };
}
