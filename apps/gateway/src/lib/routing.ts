import { getCircuitState } from "@cloudmesh/circuit-breaker";
import type { Redis } from "ioredis";
import type { AbConfig } from "./featureFlags.js";
import { getBlendedCostPer1k } from "./pricing.js";
import { getProviderStats } from "./providerStats.js";
import { computeRoutingScore, ROUTING_PRESETS, type RoutingPresetName } from "./routingScoring.js";
import type { ModelRegistry, ResolvedModel } from "../providers/index.js";

export interface ScoredCandidate {
  model: string;
  resolved: ResolvedModel;
  score: number;
}

/** A candidate's circuit is excluded from selection outright — this is a
 *  read-only peek (getCircuitState), not the authoritative gate; the actual
 *  call still goes through callProviderResilient's atomic check, same
 *  caveat as Phase 5's original fallback logic. */
async function resolveOpenCandidates(
  registry: ModelRegistry,
  redis: Redis,
  candidateModels: string[],
): Promise<{ model: string; resolved: ResolvedModel }[]> {
  const resolved: { model: string; resolved: ResolvedModel }[] = [];
  for (const model of candidateModels) {
    const r = registry.resolve(model);
    if (!r) continue;
    const state = await getCircuitState(redis, r.provider.name);
    if (state !== "open") resolved.push({ model, resolved: r });
  }
  return resolved;
}

/**
 * Scores every non-circuit-open, resolvable candidate using the design
 * doc's exact formula (see routingScoring.ts) and returns them ranked
 * best-first. Empty when every candidate is either unresolvable or
 * circuit-open — callers decide what that means (AllProvidersUnavailableError
 * vs. a fallback path).
 */
export async function scoreCandidates(
  registry: ModelRegistry,
  redis: Redis,
  candidateModels: string[],
  presetName: RoutingPresetName,
): Promise<ScoredCandidate[]> {
  const available = await resolveOpenCandidates(registry, redis, candidateModels);
  const weights = ROUTING_PRESETS[presetName].weights;

  const scored = await Promise.all(
    available.map(async ({ model, resolved }) => {
      const stats = await getProviderStats(redis, resolved.provider.name);
      const costPer1k = getBlendedCostPer1k(resolved.providerModel);
      return { model, resolved, score: computeRoutingScore(stats, costPer1k, weights) };
    }),
  );

  return scored.sort((a, b) => b.score - a.score);
}

export interface AbSelection {
  model: string;
  resolved: ResolvedModel;
  weight: number;
  normalizedWeight: number;
}

/**
 * Weighted-random selection among an org's `ab_config` variants — design
 * doc: `org.ab_config = { "gpt-4o": 0.7, "gpt-4o-mini": 0.3 } -> weighted
 * random selection per request`. Variants whose circuit is open are
 * dropped and the remaining weights renormalized (never routes traffic to
 * a provider CloudMesh already knows is failing just because the A/B split
 * said so); `undefined` when every variant is excluded, letting the caller
 * fall back to ordinary preset-scored routing rather than going fully
 * unavailable because of an A/B config that happened to point entirely at
 * down providers.
 */
export async function selectAbVariant(
  registry: ModelRegistry,
  redis: Redis,
  abConfig: AbConfig,
  random: () => number = Math.random,
): Promise<AbSelection | undefined> {
  const available = await resolveOpenCandidates(registry, redis, Object.keys(abConfig));
  if (available.length === 0) return undefined;

  const totalWeight = available.reduce((sum, { model }) => sum + abConfig[model]!, 0);
  let roll = random() * totalWeight;
  for (const { model, resolved } of available) {
    const weight = abConfig[model]!;
    roll -= weight;
    if (roll <= 0) {
      return { model, resolved, weight, normalizedWeight: weight / totalWeight };
    }
  }
  // Floating-point edge case: roll never went <= 0 (e.g. rounding put it
  // exactly at the boundary of the last candidate). Last candidate is the
  // correct pick either way.
  const last = available[available.length - 1]!;
  const weight = abConfig[last.model]!;
  return {
    model: last.model,
    resolved: last.resolved,
    weight,
    normalizedWeight: weight / totalWeight,
  };
}

function abCountKey(orgId: string, model: string): string {
  return `routing:ab:${orgId}:${model}`;
}

/**
 * The design doc's "track conversion metrics per variant" — scoped down to
 * request counts per (org, variant), the same deliberately-minimal spirit
 * as Phase 6's cache analytics (Redis counters, not a dashboard). This
 * codebase has no notion of a business "conversion" event for an LLM
 * gateway to observe, so this tracks the one signal it actually has:
 * how many requests each variant served.
 */
export async function recordAbSelection(redis: Redis, orgId: string, model: string): Promise<void> {
  await redis.incr(abCountKey(orgId, model));
}

export async function getAbStats(
  redis: Redis,
  orgId: string,
  abConfig: AbConfig,
): Promise<Record<string, number>> {
  const models = Object.keys(abConfig);
  if (models.length === 0) return {};
  const counts = await redis.mget(models.map((m) => abCountKey(orgId, m)));
  return Object.fromEntries(models.map((m, i) => [m, Number(counts[i] ?? 0)]));
}
