import { Counter, Gauge, Histogram } from "prom-client";
import { registry } from "./registry.js";

export const requestsTotal = new Counter({
  name: "cloudmesh_requests_total",
  help: "Total chat requests, by org, model, and outcome status",
  labelNames: ["org", "model", "status"] as const,
  registers: [registry],
});

export const requestDurationMs = new Histogram({
  name: "cloudmesh_request_duration_ms",
  help: "Chat request duration in milliseconds, by org and model",
  labelNames: ["org", "model"] as const,
  // Spans a fast cache hit (a few ms) through a slow uncached completion
  // (multi-second) — enough resolution for the design doc's dashboard
  // panels to compute p50/p95/p99 from this histogram's buckets.
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  registers: [registry],
});

export const tokensTotal = new Counter({
  name: "cloudmesh_tokens_total",
  help: "Total tokens processed, by org, model, and type (prompt|completion)",
  labelNames: ["org", "model", "type"] as const,
  registers: [registry],
});

export const costUsdTotal = new Counter({
  name: "cloudmesh_cost_usd_total",
  help: "Total cost in USD, by org and model",
  labelNames: ["org", "model"] as const,
  registers: [registry],
});

export const rateLimitRejectedTotal = new Counter({
  name: "cloudmesh_rate_limit_rejected_total",
  help: "Total requests rejected by the rate limiter, by org",
  labelNames: ["org"] as const,
  registers: [registry],
});

/**
 * The design doc's "usage_records write failures > 0 (billing)" alert —
 * unlike every other alert in `runbooks/`, this one pages immediately on
 * ANY occurrence, not after a sustained threshold: a silent billing write
 * failure is a revenue/trust issue, not a latency one. Incremented in
 * `apps/gateway/src/modules/chat/routes.ts` around `recordUsageAndOutbox`
 * specifically (not inferred from the generic HTTP 500 rate) — a request
 * can fail for many unrelated reasons, and conflating all of them would
 * make this alert too noisy to page on immediately the way the design doc
 * wants.
 */
export const usageWriteFailuresTotal = new Counter({
  name: "cloudmesh_usage_write_failures_total",
  help: "Total usage_records write failures — a revenue-impacting event, pages immediately on any occurrence",
  labelNames: ["org"] as const,
  registers: [registry],
});

/**
 * The design doc lists `cloudmesh_cache_hit_ratio` as its own metric name,
 * but a ratio has no native Prometheus type — Counters and Gauges are the
 * only primitives, and Phase 6 already tracks per-org hit/miss counts
 * durably in Redis (`lib/semanticCache.ts`'s `recordCacheOutcome`/
 * `getCacheStats`). A second, in-process, restart-losing gauge trying to
 * hold the "same" ratio would drift from that source of truth and reset to
 * 0 on every deploy. Exposed instead as the raw counter Prometheus
 * convention actually wants — `cloudmesh_cache_outcomes_total{outcome}` —
 * with the ratio itself computed by a Grafana panel's PromQL expression
 * (`sum(rate(...{outcome="hit"}[5m])) / sum(rate(...[5m]))`), the same way
 * every real "hit ratio" dashboard panel is built. See
 * `docker/grafana/dashboards/cache.json`.
 */
export const cacheOutcomesTotal = new Counter({
  name: "cloudmesh_cache_outcomes_total",
  help: "Semantic cache lookup outcomes (hit|miss) — see docs for how the hit ratio panel derives from this",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

const CIRCUIT_STATE_VALUE = { closed: 0, half_open: 1, open: 2 } as const;

/** 0=closed, 1=half_open, 2=open — an escalating-severity numeric mapping,
 *  documented here since a Prometheus gauge is numeric-only and this isn't
 *  self-describing on a dashboard without it (see the same mapping's
 *  legend in docker/grafana/dashboards/provider.json). */
export const circuitBreakerState = new Gauge({
  name: "cloudmesh_circuit_breaker_state",
  help: "Circuit breaker state by provider: 0=closed, 1=half_open, 2=open",
  labelNames: ["provider"] as const,
  registers: [registry],
});

export function setCircuitBreakerState(
  provider: string,
  state: keyof typeof CIRCUIT_STATE_VALUE,
): void {
  circuitBreakerState.set({ provider }, CIRCUIT_STATE_VALUE[state]);
}
