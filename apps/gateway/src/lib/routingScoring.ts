import type { ProviderStats } from "./providerStats.js";

export interface RoutingWeights {
  latency: number;
  cost: number;
  reliability: number;
}

export interface RoutingPreset {
  name: string;
  weights: RoutingWeights;
}

/**
 * Named presets — what "auto" actually optimizes for. Weights are never
 * hand-set per request; an org picks one of these three
 * (`organizations.feature_flags.routing_preset`), matching the design
 * doc's framing: "auto" has a defined, backtested meaning instead of
 * discovering it while debugging. The specific numbers are the design
 * doc's own shipped values, not independently re-derived here — see
 * CLAUDE.md's Phase 8 notes for why this codebase doesn't (and can't)
 * actually re-run the "backtested against 30 days of logs" process the
 * doc's narrative describes.
 */
export const ROUTING_PRESETS = {
  cost_optimized: {
    name: "cost_optimized",
    weights: { latency: 0.2, cost: 0.6, reliability: 0.2 },
  },
  latency_optimized: {
    name: "latency_optimized",
    weights: { latency: 0.6, cost: 0.1, reliability: 0.3 },
  },
  balanced: { name: "balanced", weights: { latency: 0.3, cost: 0.4, reliability: 0.3 } },
} as const satisfies Record<string, RoutingPreset>;

export type RoutingPresetName = keyof typeof ROUTING_PRESETS;

export const DEFAULT_ROUTING_PRESET: RoutingPresetName = "cost_optimized";

export function isRoutingPresetName(value: unknown): value is RoutingPresetName {
  return typeof value === "string" && value in ROUTING_PRESETS;
}

// A provider/model with zero real samples yet (freshly deployed, or just
// past the stats window's idle timeout) must not score as either
// infinitely good (an unvalidated 0ms/0-cost reading dominating everyone
// else) or be excluded outright — it's genuinely unknown, so it's scored
// as a plausible, unremarkable "average" performer until real data
// accumulates. These are assumptions, not measurements; deliberately
// modest rather than optimistic.
const ASSUMED_P99_MS_WHEN_UNKNOWN = 1000;
const ASSUMED_SUCCESS_RATE_WHEN_UNKNOWN = 0.95;

// A literal 0ms latency or $0 cost would make the reciprocal terms below
// divide by zero (Infinity, then NaN once compared/summed against a finite
// score) — floors keep a genuinely free/fast provider scoring very high
// without breaking arithmetic for everything being compared against it.
const MIN_LATENCY_MS = 1;
const MIN_COST_PER_1K = 0.000001;

/**
 * `score = (1/p99_latency_ms)*weight_latency + (1/cost_per_1k_tokens)*weight_cost
 *        + success_rate*weight_reliability` — the design doc's exact formula,
 * unmodified. Higher is better; candidates are compared against each other,
 * not against any absolute threshold.
 */
export function computeRoutingScore(
  stats: ProviderStats,
  costPer1kTokens: number,
  weights: RoutingWeights,
): number {
  const p99Ms =
    stats.sampleCount > 0 ? Math.max(stats.p99Ms, MIN_LATENCY_MS) : ASSUMED_P99_MS_WHEN_UNKNOWN;
  const successRate = stats.sampleCount > 0 ? stats.successRate : ASSUMED_SUCCESS_RATE_WHEN_UNKNOWN;
  const cost = Math.max(costPer1kTokens, MIN_COST_PER_1K);

  return (
    (1 / p99Ms) * weights.latency + (1 / cost) * weights.cost + successRate * weights.reliability
  );
}
