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
