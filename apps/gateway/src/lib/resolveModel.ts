import type { Redis } from "ioredis";
import type { AbConfig } from "./featureFlags.js";
import { scoreCandidates, selectAbVariant, type ScoredCandidate } from "./routing.js";
import { DEFAULT_ROUTING_PRESET, type RoutingPresetName } from "./routingScoring.js";
import { env } from "../env.js";
import { AllProvidersUnavailableError, ValidationError } from "../errors.js";
import type { ModelRegistry, ResolvedModel } from "../providers/index.js";

export interface RoutingOptions {
  preset: RoutingPresetName;
  abConfig?: AbConfig;
}

export type RouteReason = "explicit" | "ab_variant" | "scored";

/** Everything worth logging about how a request's model was picked — the
 *  design doc's "routing logs" deliverable. Structured pino logging (see
 *  modules/chat/routes.ts) rather than a new DB table: this is operational
 *  observability, not billing-critical transactional data (unlike
 *  usage_records), so it doesn't need the durability/queryability a table
 *  buys — see CLAUDE.md's Phase 8 notes for the full reasoning. */
export interface RouteDecision {
  resolved: ResolvedModel;
  reason: RouteReason;
  presetUsed?: RoutingPresetName;
  abVariant?: { model: string; normalizedWeight: number };
  candidatesConsidered?: Pick<ScoredCandidate, "model" | "score">[];
}

/**
 * Resolves a request's model to a provider — with routing ONLY for
 * `model: "auto"`. An explicit model request never gets silently served by
 * a different model: if its provider's circuit is open, that surfaces as
 * a normal CircuitOpenError from callProviderResilient (see
 * lib/resilience.ts), not a swap.
 *
 * For "auto": if the org has an `ab_config` (Phase 8 A/B routing), a
 * weighted-random variant is tried first; if every variant is
 * circuit-excluded, this falls through to ordinary preset-scored routing
 * rather than going unavailable because of an A/B split that happened to
 * point entirely at down providers. Preset-scored routing scores every
 * resolvable, non-circuit-open candidate from
 * `[env.DEFAULT_MODEL, ...env.AUTO_FALLBACK_MODELS]` using the org's named
 * weight preset (routingScoring.ts) and picks the best. Both paths are a
 * read-only circuit peek (getCircuitState, inside routing.ts) — the actual
 * call still goes through callProviderResilient's atomic check, so a race
 * between "we picked this candidate" and "its circuit just opened" fails
 * safely (a normal CircuitOpenError on that attempt), it just doesn't get
 * a second automatic try at a different candidate.
 */
export async function resolveModelWithFallback(
  registry: ModelRegistry,
  redis: Redis,
  modelName: string,
  routing: RoutingOptions = { preset: DEFAULT_ROUTING_PRESET },
): Promise<RouteDecision> {
  if (modelName !== "auto") {
    const resolved = registry.resolve(modelName);
    if (!resolved) {
      throw new ValidationError(`Unknown model: ${modelName}`);
    }
    return { resolved, reason: "explicit" };
  }

  if (routing.abConfig) {
    const variant = await selectAbVariant(registry, redis, routing.abConfig);
    if (variant) {
      return {
        resolved: variant.resolved,
        reason: "ab_variant",
        abVariant: { model: variant.model, normalizedWeight: variant.normalizedWeight },
      };
    }
    // Every A/B variant was circuit-excluded — fall through to ordinary
    // preset-scored routing below rather than surfacing unavailability
    // caused by an A/B config pointing entirely at down providers.
  }

  const candidateModels = [env.DEFAULT_MODEL, ...env.AUTO_FALLBACK_MODELS];
  const scored = await scoreCandidates(registry, redis, candidateModels, routing.preset);

  if (scored.length === 0) {
    // Distinguish "every candidate we could resolve had an open circuit"
    // (a real outage signal per the design doc: "All OPEN -> queue or
    // 503") from "none of these model names even resolve to a configured
    // provider" (a config/ValidationError problem, not an outage).
    const anyResolvable = candidateModels.some((m) => registry.resolve(m) !== undefined);
    if (anyResolvable) {
      throw new AllProvidersUnavailableError();
    }
    throw new ValidationError(`Unknown model: ${modelName}`);
  }

  const best = scored[0]!;
  return {
    resolved: best.resolved,
    reason: "scored",
    presetUsed: routing.preset,
    candidatesConsidered: scored.map((s) => ({ model: s.model, score: s.score })),
  };
}
