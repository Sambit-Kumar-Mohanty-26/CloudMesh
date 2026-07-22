import { getCircuitState } from "@cloudmesh/circuit-breaker";
import type { Redis } from "ioredis";
import { env } from "../env.js";
import { AllProvidersUnavailableError, ValidationError } from "../errors.js";
import type { ModelRegistry, ResolvedModel } from "../providers/index.js";

/**
 * Resolves a request's model to a provider — with fallback ONLY for
 * `model: "auto"`. An explicit model request never gets silently served by
 * a different model: if its provider's circuit is open, that surfaces as
 * a normal CircuitOpenError from callProviderResilient (see
 * lib/resilience.ts), not a swap.
 *
 * For "auto", tries env.DEFAULT_MODEL then env.AUTO_FALLBACK_MODELS in
 * order, skipping any candidate whose circuit is currently open. This is a
 * read-only peek (getCircuitState), not the authoritative gate — the
 * actual call still goes through callProviderResilient's atomic check, so
 * a race between "we picked this candidate" and "its circuit just opened"
 * fails safely (as a normal CircuitOpenError on that attempt), it just
 * doesn't get a second automatic try at a different provider.
 */
export async function resolveModelWithFallback(
  registry: ModelRegistry,
  redis: Redis,
  modelName: string,
): Promise<ResolvedModel> {
  if (modelName !== "auto") {
    const resolved = registry.resolve(modelName);
    if (!resolved) {
      throw new ValidationError(`Unknown model: ${modelName}`);
    }
    return resolved;
  }

  const candidates = [env.DEFAULT_MODEL, ...env.AUTO_FALLBACK_MODELS];
  let lastResolved: ResolvedModel | undefined;

  for (const candidate of candidates) {
    const resolved = registry.resolve(candidate);
    if (!resolved) continue;
    lastResolved = resolved;

    const state = await getCircuitState(redis, resolved.provider.name);
    if (state !== "open") {
      return resolved;
    }
  }

  // Every candidate we could resolve had an open circuit. Falling back to
  // the last one anyway (rather than the caller never learning why) — no:
  // per the design doc ("All OPEN -> queue or 503"), this is a real outage
  // signal, not something to paper over by trying anyway.
  if (lastResolved) {
    throw new AllProvidersUnavailableError();
  }
  throw new ValidationError(`Unknown model: ${modelName}`);
}
