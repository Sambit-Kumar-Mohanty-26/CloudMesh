/**
 * One error class per meaningful failure mode, so callers can branch on
 * `instanceof` rather than parsing status codes or message strings.
 *
 * Every error carries the server's stable `code` field — that's the value
 * to switch on. Messages are human-readable and may change.
 */
export class CloudMeshError extends Error {
  readonly status: number;
  readonly code: string;
  /** Present when the server supplied a request id, for support tickets. */
  readonly requestId?: string;

  constructor(message: string, status: number, code: string, requestId?: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** 401 — missing, malformed, or revoked key. Revocation is immediate. */
export class AuthenticationError extends CloudMeshError {}

/** 400 — the request body or query failed validation. */
export class InvalidRequestError extends CloudMeshError {}

/** 402 — the organization's budget is exhausted. */
export class BudgetExceededError extends CloudMeshError {}

/** 404 — no such resource, or it belongs to another organization. The API
 *  deliberately does not distinguish the two. */
export class NotFoundError extends CloudMeshError {}

/** 429 — rate limited. `retryAfterSeconds` comes from the Retry-After
 *  header; the client already honours it when retrying automatically. */
export class RateLimitError extends CloudMeshError {
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    status: number,
    code: string,
    retryAfterSeconds?: number,
    requestId?: string,
  ) {
    super(message, status, code, requestId);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 5xx, including 502 (upstream provider failed) and 503 (every candidate
 *  provider's circuit is open). */
export class ServiceError extends CloudMeshError {}

/** The request never produced an HTTP response — DNS failure, connection
 *  refused, timeout, or an aborted signal. */
export class ConnectionError extends CloudMeshError {
  constructor(message: string, cause?: unknown) {
    super(message, 0, "CONNECTION_ERROR");
    this.cause = cause;
  }
}

export function errorFromResponse(
  status: number,
  body: { error?: string; code?: string } | undefined,
  retryAfterSeconds?: number,
  requestId?: string,
): CloudMeshError {
  const message = body?.error ?? `Request failed with status ${status}`;
  const code = body?.code ?? "UNKNOWN";

  switch (status) {
    case 400:
      return new InvalidRequestError(message, status, code, requestId);
    case 401:
      return new AuthenticationError(message, status, code, requestId);
    case 402:
      return new BudgetExceededError(message, status, code, requestId);
    case 404:
      return new NotFoundError(message, status, code, requestId);
    case 429:
      return new RateLimitError(message, status, code, retryAfterSeconds, requestId);
    default:
      return status >= 500
        ? new ServiceError(message, status, code, requestId)
        : new CloudMeshError(message, status, code, requestId);
  }
}
