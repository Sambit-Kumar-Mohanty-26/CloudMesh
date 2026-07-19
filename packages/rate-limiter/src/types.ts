export interface RateLimitResult {
  allowed: boolean;
  /** Best-effort remaining capacity — meaning varies slightly per
   *  algorithm (exact count for Fixed Window/Sliding Log, weighted
   *  estimate for Sliding Counter, fractional tokens for Token Bucket). */
  remaining: number;
  /** Epoch ms after which the caller can usefully retry. Always present —
   *  callers (e.g. the 429 Retry-After header) depend on it. */
  resetAt: number;
}
