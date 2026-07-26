import type { UnifiedUsage } from "../providers/types.js";

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Best-effort snapshot of provider list pricing, not fetched live — same
 * caveat as GET /v1/models' catalog (see Phase 3 notes in CLAUDE.md): this
 * codebase's own knowledge of "current" prices goes stale the moment it's
 * written. Verify against each provider's actual pricing page before
 * relying on this for real invoicing; treat it as directionally correct,
 * not authoritative. A model not listed here (e.g. any Ollama model,
 * self-hosted and free to run) prices at $0 rather than throwing — an
 * unrecognized model shouldn't crash the response it's costing out.
 */
const PRICING: Record<string, ModelPricing> = {
  "gpt-4o": { inputPerMillion: 5, outputPerMillion: 15 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "claude-3-5-sonnet-20241022": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-3-5-haiku-20241022": { inputPerMillion: 0.8, outputPerMillion: 4 },
  "gemini-1.5-pro": { inputPerMillion: 1.25, outputPerMillion: 5 },
  "gemini-1.5-flash": { inputPerMillion: 0.075, outputPerMillion: 0.3 },
};

const FREE: ModelPricing = { inputPerMillion: 0, outputPerMillion: 0 };

export function getModelPricing(model: string): ModelPricing {
  return PRICING[model] ?? FREE;
}

/** Blended input/output average, per 1k tokens — the routing engine's
 *  scoring formula (see lib/routingScoring.ts) needs a single "cost per
 *  1k tokens" figure per model to score candidates against each other
 *  before a request has actually run, so there's no real input/output
 *  split to weight by yet. An average of the two published rates is the
 *  best a priori estimate available at routing time. */
export function getBlendedCostPer1k(model: string): number {
  const pricing = getModelPricing(model);
  return (pricing.inputPerMillion + pricing.outputPerMillion) / 2 / 1000;
}

/** Rounded to match usage_records.cost_usd's DECIMAL(12,6) column — avoids
 *  handing Prisma a float with more binary-floating-point noise than the
 *  column can even store. */
export function computeCostUsd(model: string, usage: UnifiedUsage): number {
  const pricing = getModelPricing(model);
  const cost =
    (usage.promptTokens / 1_000_000) * pricing.inputPerMillion +
    (usage.completionTokens / 1_000_000) * pricing.outputPerMillion;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
