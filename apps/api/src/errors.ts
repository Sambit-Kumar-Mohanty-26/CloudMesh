export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
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

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, message, "FORBIDDEN");
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(409, message, "CONFLICT");
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, message, "NOT_FOUND");
  }
}

export class ValidationError extends AppError {
  constructor(message = "Invalid request") {
    super(400, message, "VALIDATION_ERROR");
  }
}

/** A Stripe API call failed, or a webhook's signature couldn't be verified
 *  — the upstream/caller's problem, not an internal bug in this service. */
export class ProviderError extends AppError {
  constructor(
    message: string,
    public readonly provider: string,
    statusCode = 502,
  ) {
    super(statusCode, message, "PROVIDER_ERROR");
  }
}
