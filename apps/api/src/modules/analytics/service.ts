import { withTenant, type PrismaClient } from "@cloudmesh/db";

export type Period = "24h" | "7d" | "30d";

const PERIOD_LOOKBACK_MS: Record<Period, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export interface HourlyBucket {
  bucket: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface ModelBreakdown {
  model: string;
  requests: number;
  costUsd: number;
}

export interface AnalyticsSummary {
  period: Period;
  buckets: HourlyBucket[];
  byModel: ModelBreakdown[];
  totals: { requests: number; tokens: number; costUsd: number };
}

interface BucketRow {
  bucket: Date;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: unknown;
}

interface ModelRow {
  model: string;
  requests: number;
  cost_usd: unknown;
}

/**
 * The design doc's "Postgres aggregation query (pre-computed hourly)" —
 * implemented as a live `date_trunc('hour', ...)` GROUP BY over
 * `usage_records` (already indexed on `(org_id, created_at)` since Phase
 * 1), not a separate materialized rollup table. At this gateway's actual
 * traffic scale a live aggregation is fast and always current; a rollup
 * table would trade that freshness for write-side complexity (a job to
 * keep it in sync) this phase's data volume doesn't justify. Revisit if a
 * real deployment's usage_records grows large enough to make this query
 * slow — the index already in place is what makes it viable at all.
 */
export async function getAnalytics(
  db: PrismaClient,
  orgId: string,
  period: Period,
  now: Date = new Date(),
): Promise<AnalyticsSummary> {
  const since = new Date(now.getTime() - PERIOD_LOOKBACK_MS[period]);

  const [bucketRows, modelRows] = await withTenant(db, orgId, async (tx) => {
    const buckets = await tx.$queryRaw<BucketRow[]>`
      SELECT date_trunc('hour', created_at) AS bucket,
             COUNT(*)::int AS requests,
             COALESCE(SUM(prompt_tokens), 0)::int AS prompt_tokens,
             COALESCE(SUM(completion_tokens), 0)::int AS completion_tokens,
             COALESCE(SUM(cost_usd), 0)::numeric AS cost_usd
      FROM usage_records
      WHERE org_id = ${orgId}::uuid AND created_at >= ${since}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;
    const models = await tx.$queryRaw<ModelRow[]>`
      SELECT model,
             COUNT(*)::int AS requests,
             COALESCE(SUM(cost_usd), 0)::numeric AS cost_usd
      FROM usage_records
      WHERE org_id = ${orgId}::uuid AND created_at >= ${since}
      GROUP BY model
      ORDER BY cost_usd DESC
    `;
    return [buckets, models] as const;
  });

  const buckets: HourlyBucket[] = bucketRows.map((r) => ({
    bucket: r.bucket.toISOString(),
    requests: r.requests,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    costUsd: Number(r.cost_usd),
  }));
  const byModel: ModelBreakdown[] = modelRows.map((r) => ({
    model: r.model,
    requests: r.requests,
    costUsd: Number(r.cost_usd),
  }));
  const totals = buckets.reduce(
    (acc, b) => ({
      requests: acc.requests + b.requests,
      tokens: acc.tokens + b.promptTokens + b.completionTokens,
      costUsd: acc.costUsd + b.costUsd,
    }),
    { requests: 0, tokens: 0, costUsd: 0 },
  );

  return { period, buckets, byModel, totals };
}

export interface LogEntry {
  id: string;
  createdAt: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  requestId: string;
}

/**
 * The design doc's "/dashboard/logs — request log explorer (filters)".
 * Scoped to what's actually durable and queryable: `usage_records` is the
 * one per-request table this codebase persists (Phase 12's structured
 * logs and traces are real, but transient — stdout/Jaeger, never written
 * to Postgres). A row here is "a billed request," not a full HTTP
 * request/response log (status code, headers, error detail aren't
 * captured here) — good enough for "what did this org's traffic look
 * like," not a substitute for pulling the real trace/log from Jaeger for
 * one specific failing request.
 */
export async function listRequestLogs(
  db: PrismaClient,
  orgId: string,
  filters: { model?: string; limit?: number },
): Promise<LogEntry[]> {
  const limit = Math.min(filters.limit ?? 50, 200);
  const rows = await withTenant(db, orgId, (tx) =>
    tx.usageRecord.findMany({
      where: { orgId, ...(filters.model ? { model: filters.model } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    model: r.model,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    costUsd: Number(r.costUsd),
    requestId: r.requestId,
  }));
}
