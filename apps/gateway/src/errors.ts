export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
    /** Extra response headers the error handler should set — e.g.
     *  Retry-After on a 429. Optional; most error types don't need this. */
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, message, "UNAUTHORIZED");
  }
}

export class ValidationError extends AppError {
  constructor(message = "Invalid request") {
    super(400, message, "VALIDATION_ERROR");
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, message, "NOT_FOUND");
  }
}

/** A provider request failed — the upstream LLM API, not this gateway. */
export class ProviderError extends AppError {
  constructor(
    message: string,
    public readonly provider: string,
  ) {
    super(502, message, "PROVIDER_ERROR");
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(429, "Rate limit exceeded", "RATE_LIMITED", {
      "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))),
    });
  }
}

/** The circuit breaker for a specific provider is open — this gateway is
 *  deliberately refusing to call it right now, not the provider itself
 *  rejecting the request (that would be ProviderError, 502). */
export class ServiceUnavailableError extends AppError {
  constructor(message: string, retryAfterSeconds?: number, code = "SERVICE_UNAVAILABLE") {
    super(
      503,
      message,
      code,
      retryAfterSeconds !== undefined
        ? { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) }
        : undefined,
    );
  }
}

/** Every candidate provider for model:"auto" has an open circuit — a real
 *  outage signal per the design doc ("All OPEN -> queue or 503"), not
 *  something to paper over by trying one anyway. */
export class AllProvidersUnavailableError extends ServiceUnavailableError {
  constructor() {
    super(
      "All configured providers are currently unavailable",
      undefined,
      "ALL_PROVIDERS_UNAVAILABLE",
    );
  }
}
