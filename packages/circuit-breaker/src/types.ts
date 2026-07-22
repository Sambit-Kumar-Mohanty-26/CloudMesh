export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  /** Failures within `failureWindowMs` before the circuit trips open. */
  failureThreshold: number;
  /** Rolling window the failure count is measured over, while closed. */
  failureWindowMs: number;
  /** How long the circuit stays open before allowing one probe request
   *  through (half-open). */
  openDurationMs: number;
}

export class CircuitOpenError extends Error {
  constructor(public readonly circuitName: string) {
    super(`Circuit breaker is open for "${circuitName}"`);
    this.name = "CircuitOpenError";
  }
}
