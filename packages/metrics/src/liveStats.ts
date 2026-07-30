/**
 * The Redis pub/sub channel name convention shared between
 * apps/gateway (the only publisher — see its lib/orgLiveStats.ts) and
 * apps/api (the only subscriber — its WS /ws/live-stats route). Living
 * here, in the one package both apps already depend on, instead of being
 * independently duplicated as a string literal in each, is what prevents a
 * silent naming-drift bug: a publisher and subscriber that disagree on the
 * channel name don't error, they just never see each other's traffic —
 * the exact same class of bug Phase 9's BullMQ queue-prefix mismatch
 * documents.
 */
export function liveStatsChannel(orgId: string): string {
  return `analytics:${orgId}`;
}

export interface LiveStats {
  rps: number;
  p99: number;
  errors: number;
}
