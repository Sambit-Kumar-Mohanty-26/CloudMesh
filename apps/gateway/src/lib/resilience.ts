import { CircuitOpenError, withCircuitBreaker, withRetry } from "@cloudmesh/circuit-breaker";
import type { Redis } from "ioredis";
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
