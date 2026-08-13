"""Typed exceptions for the CloudMesh SDK.

One class per meaningful failure mode so callers can use ``except`` rather
than inspecting status codes. Every error carries the server's stable
``code`` field — switch on that, not on the message, which may change.
"""

from __future__ import annotations

from typing import Any


class CloudMeshError(Exception):
    """Base class for every error this SDK raises."""

    def __init__(
        self,
        message: str,
        status: int = 0,
        code: str = "UNKNOWN",
        request_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.request_id = request_id

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"{type(self).__name__}(status={self.status}, code={self.code!r})"


class AuthenticationError(CloudMeshError):
    """401 — missing, malformed, or revoked API key. Revocation is immediate."""


class InvalidRequestError(CloudMeshError):
    """400 — the request body or query failed validation."""


class BudgetExceededError(CloudMeshError):
    """402 — the organization's budget is exhausted."""


class NotFoundError(CloudMeshError):
    """404 — no such resource, or it belongs to another organization.

    The API deliberately does not distinguish the two, so this never
    confirms that another tenant's id exists.
    """


class RateLimitError(CloudMeshError):
    """429 — rate limited. ``retry_after_seconds`` mirrors Retry-After."""

    def __init__(
        self,
        message: str,
        status: int = 429,
        code: str = "RATE_LIMITED",
        retry_after_seconds: float | None = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(message, status, code, request_id)
        self.retry_after_seconds = retry_after_seconds


class ServiceError(CloudMeshError):
    """5xx — including 502 (upstream provider failed) and 503 (every
    candidate provider's circuit is open)."""


class ConnectionError_(CloudMeshError):
    """No HTTP response at all — DNS failure, refused connection, timeout.

    Named with a trailing underscore so it does not shadow the builtin
    ``ConnectionError``; exported as ``CloudMeshConnectionError``.
    """


CloudMeshConnectionError = ConnectionError_


def error_from_response(
    status: int,
    body: dict[str, Any] | None,
    retry_after_seconds: float | None = None,
    request_id: str | None = None,
) -> CloudMeshError:
    """Maps an HTTP error response onto the right exception class."""
    message = (body or {}).get("error") or f"Request failed with status {status}"
    code = (body or {}).get("code") or "UNKNOWN"

    if status == 400:
        return InvalidRequestError(message, status, code, request_id)
    if status == 401:
        return AuthenticationError(message, status, code, request_id)
    if status == 402:
        return BudgetExceededError(message, status, code, request_id)
    if status == 404:
        return NotFoundError(message, status, code, request_id)
    if status == 429:
        return RateLimitError(message, status, code, retry_after_seconds, request_id)
    if status >= 500:
        return ServiceError(message, status, code, request_id)
    return CloudMeshError(message, status, code, request_id)
