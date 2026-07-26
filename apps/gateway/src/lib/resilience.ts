import { CircuitOpenError, withCircuitBreaker, withRetry } from "@cloudmesh/circuit-breaker";
import type { Redis } from "ioredis";
import { recordProviderOutcome } from "./providerStats.js";
import { env } from "../env.js";
import { ServiceUnavailableError } from "../errors.js";

/**
 * Wraps a single provider call with retry (exponential backoff + jitter)
 * around circuit breaker protection. Retry is the OUTER layer on purpose:
 * each individual attempt re-checks the circuit first, so if the circuit
 * trips open partway through a retry sequence, the very next attempt fails
 * fast instead of waiting out a full backoff delay first. `shouldRetry`
 * excludes CircuitOpenError itself — retrying against a breaker that just
 * told you to stop is wasted latency, not resilience.
 */
export async function callProviderResilient<T>(
  redis: Redis,
  providerName: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await withRetry(
      { maxAttempts: env.RETRY_MAX_ATTEMPTS, baseDelayMs: env.RETRY_BASE_DELAY_MS },
      () =>
        withCircuitBreaker(
          redis,
          providerName,
          {
            failureThreshold: env.CIRCUIT_FAILURE_THRESHOLD,
            failureWindowMs: env.CIRCUIT_FAILURE_WINDOW_MS,
            openDurationMs: env.CIRCUIT_OPEN_DURATION_MS,
          },
          fn,
        ),
      { shouldRetry: (err) => !(err instanceof CircuitOpenError) },
    );
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      throw new ServiceUnavailableError(
        `${providerName} is temporarily unavailable (circuit open)`,
        env.CIRCUIT_OPEN_DURATION_MS / 1000,
      );
    }
    throw err;
  }
}

/**
 * Same as callProviderResilient, plus recording the outcome for Phase 8's
 * routing engine (lib/routingScoring.ts reads these via
 * lib/providerStats.ts to score candidates on real latency/reliability,
 * not guesswork). A circuit-open short-circuit is deliberately NOT
 * recorded as a failed attempt — no real call happened, so it carries no
 * signal about the provider's actual current latency/success rate, and
 * recording it as a "failure" would double-penalize an already-open
 * circuit and pollute the success-rate stat with non-attempts.
 * `callProviderResilient` only ever wraps a `CircuitOpenError` as
 * `ServiceUnavailableError` (see above) — any OTHER thrown error is a
 * genuine attempt that failed for real, so it IS recorded.
 */
export async function callProviderResilientWithStats<T>(
  redis: Redis,
  providerName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await callProviderResilient(redis, providerName, fn);
    await recordProviderOutcome(redis, providerName, Date.now() - start, true);
    return result;
  } catch (err) {
    if (!(err instanceof ServiceUnavailableError)) {
      await recordProviderOutcome(redis, providerName, Date.now() - start, false);
    }
    throw err;
  }
}
