import { randomUUID } from "node:crypto";
import { liveStatsChannel, type LiveStats } from "@cloudmesh/metrics";
import type { Redis } from "ioredis";

export { liveStatsChannel };

/**
 * Backs the Phase 13 dashboard's "Live request counter" (`WS
 * /ws/live-stats` in apps/api, subscribing to the channel this file
 * publishes to). Same atomic record-and-trim Redis+Lua pattern as Phase
 * 8's providerStats.ts — a bounded sliding window of recent request
 * outcomes, per org rather than per provider (provider stats answer "how
 * is this external dependency doing," global by design; this answers "how
 * is THIS org's traffic doing right now," which only makes sense scoped to
 * the org watching its own dashboard).
 */
const WINDOW_MS = 60_000;
const ACTIVE_ORGS_KEY = "livestats:active_orgs";

function statsKey(orgId: string): string {
  return `livestats:${orgId}`;
}

const RECORD_SCRIPT = `
local key = KEYS[1]
local activeOrgsKey = KEYS[2]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local member = ARGV[3]
local orgId = ARGV[4]
redis.call("ZADD", key, now, member)
redis.call("ZREMRANGEBYSCORE", key, "-inf", now - windowMs)
redis.call("PEXPIRE", key, windowMs)
redis.call("SADD", activeOrgsKey, orgId)
return 1
`;

/** Records one completed chat request's outcome for the live-stats window
 *  — called from the same exit points in modules/chat/routes.ts that
 *  record cloudmesh_requests_total. */
export async function recordOrgRequestOutcome(
  redis: Redis,
  orgId: string,
  latencyMs: number,
  isError: boolean,
  now: number = Date.now(),
): Promise<void> {
  const member = `${now}:${Math.round(latencyMs)}:${isError ? 1 : 0}:${randomUUID()}`;
  await redis.eval(
    RECORD_SCRIPT,
    2,
    statsKey(orgId),
    ACTIVE_ORGS_KEY,
    String(now),
    String(WINDOW_MS),
    member,
    orgId,
  );
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export async function getOrgLiveStats(
  redis: Redis,
  orgId: string,
  now: number = Date.now(),
): Promise<LiveStats> {
  const key = statsKey(orgId);
  await redis.zremrangebyscore(key, "-inf", now - WINDOW_MS);
  const members = await redis.zrange(key, 0, -1);
  if (members.length === 0) return { rps: 0, p99: 0, errors: 0 };

  const latencies: number[] = [];
  let errors = 0;
  for (const member of members) {
    const [, latStr, errStr] = member.split(":");
    latencies.push(Number(latStr));
    if (errStr === "1") errors++;
  }
  latencies.sort((a, b) => a - b);

  return {
    rps: Number((members.length / (WINDOW_MS / 1000)).toFixed(2)),
    p99: percentile(latencies, 99),
    errors,
  };
}

/** Orgs with at least one recorded sample since the last time this ran —
 *  what the periodic publisher (server.ts) iterates to know who to
 *  `PUBLISH` to, without a full Redis `SCAN` on every tick. Deliberately
 *  never pruned: a stale entry just means one extra, cheap `getOrgLiveStats`
 *  call that returns all-zeros for an org with no recent traffic, not a
 *  correctness problem — acceptable for this phase's scope. */
export async function getActiveOrgIds(redis: Redis): Promise<string[]> {
  return redis.smembers(ACTIVE_ORGS_KEY);
}
