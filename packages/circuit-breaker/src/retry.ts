export interface RetryConfig {
  maxAttempts: number;
  /** Base delay for attempt 1 — subsequent attempts double it
   *  (`baseDelayMs * 2^(attempt-1)`), matching the design doc's
   *  1s / 2s / 4s / 8s progression. */
  baseDelayMs: number;
}

/** attempt 1: baseDelayMs + rand(0, baseDelayMs/2); attempt 2: doubled;
 *  etc. — exactly the "1s + rand(0-0.5s), 2s + rand(0-1s), ..." spec. */
export function computeBackoffDelay(
  attempt: number,
  config: RetryConfig,
  random: () => number = Math.random,
): number {
  const exponential = config.baseDelayMs * 2 ** (attempt - 1);
  const jitter = random() * (exponential / 2);
  return exponential + jitter;
}

/**
 * Retries `fn` up to `maxAttempts` times with exponential backoff + jitter
 * between attempts. `shouldRetry` lets callers opt out for errors retrying
 * can't help with — most importantly CircuitOpenError, where burning
 * through a whole backoff sequence against a circuit that just opened is
 * pure wasted latency, not resilience.
 */
export async function withRetry<T>(
  config: RetryConfig,
  fn: (attempt: number) => Promise<T>,
  options: {
    shouldRetry?: (err: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  } = {},
): Promise<T> {
  const shouldRetry = options.shouldRetry ?? (() => true);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= config.maxAttempts || !shouldRetry(err)) {
        throw err;
      }
      await sleep(computeBackoffDelay(attempt, config, random));
    }
  }
  // Unreachable (loop always returns or throws), but keeps TS satisfied.
  throw lastError;
}
