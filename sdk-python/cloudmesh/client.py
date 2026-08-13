"""The CloudMesh client.

Built on ``urllib`` from the standard library rather than ``requests`` or
``httpx``: an SDK with zero third-party dependencies can be dropped into any
environment without dependency-resolution conflicts, which matters far more
for a client library than the ergonomics of the HTTP layer it hides.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Iterator

from .errors import CloudMeshError, ConnectionError_, RateLimitError, error_from_response

__all__ = ["CloudMesh", "ChatResponse", "ChatChunk"]

DEFAULT_BASE_URL = "http://localhost:3001"
DEFAULT_TIMEOUT = 60.0
DEFAULT_MAX_RETRIES = 2
SDK_VERSION = "0.1.0"


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    """Convenience sum computed by this SDK. The API returns only the two
    components; it does not send a total of its own."""


@dataclass
class ChatResponse:
    id: str
    model: str
    """The model that actually served the request — for ``model="auto"``
    this may differ from what was asked for."""
    provider: str = ""
    """Which upstream served it, e.g. "openai", "anthropic", "mock"."""
    content: str = ""
    finish_reason: str | None = None
    usage: Usage = field(default_factory=Usage)
    cached: bool = False
    """True when served from the semantic cache. Cache hits are never
    billed, because no new provider call happened."""
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class ChatChunk:
    """One streamed delta. ``text`` is the increment, not the running total."""

    text: str


class CloudMesh:
    """Client for the CloudMesh AI gateway.

    >>> cm = CloudMesh(api_key="cm_live_...")
    >>> response = cm.chat.create(model="auto", messages=[{"role": "user", "content": "Hi"}])
    >>> print(response.content)
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        if not api_key:
            raise ValueError("CloudMesh: api_key is required.")
        self._api_key = api_key
        # A trailing slash would produce //v1/chat, which some proxies treat
        # as a different path than /v1/chat.
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries

        self.chat = _Chat(self)
        self.models = _Models(self)
        self.jobs = _Jobs(self)

    # -- internals -------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "User-Agent": f"cloudmesh-sdk-python/{SDK_VERSION}",
        }

    def _open(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> Any:
        """Performs the request with retries, returning the raw response.

        Only 429 and 5xx are retried. A 400 or 401 fails identically forever,
        and retrying a 402 just hammers a budget that is already exhausted.
        """
        url = f"{self._base_url}{path}"
        headers = {**self._headers(), **(extra_headers or {})}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        last_error: CloudMeshError | None = None

        for attempt in range(self._max_retries + 1):
            request = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                return urllib.request.urlopen(request, timeout=self._timeout)  # noqa: S310
            except urllib.error.HTTPError as exc:
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                try:
                    retry_after_seconds = float(retry_after) if retry_after else None
                except ValueError:
                    retry_after_seconds = None

                try:
                    payload = json.loads(exc.read().decode("utf-8"))
                except Exception:  # noqa: BLE001 - a non-JSON error body is still an error
                    payload = None

                error = error_from_response(
                    exc.code,
                    payload if isinstance(payload, dict) else None,
                    retry_after_seconds,
                    exc.headers.get("X-Request-Id") if exc.headers else None,
                )

                retryable = exc.code == 429 or exc.code >= 500
                if not retryable or attempt == self._max_retries:
                    raise error from None

                # Honour Retry-After when present: the server knows when its
                # token bucket actually refills.
                if isinstance(error, RateLimitError) and error.retry_after_seconds is not None:
                    time.sleep(error.retry_after_seconds)
                else:
                    time.sleep(2**attempt * 0.25)
                last_error = error
            except urllib.error.URLError as exc:
                last_error = ConnectionError_(f"Network request failed: {exc.reason}")
                if attempt == self._max_retries:
                    raise last_error from None
                time.sleep(2**attempt * 0.25)

        raise last_error or ConnectionError_("Request failed.")  # pragma: no cover

    def _request_json(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        with self._open(method, path, body, extra_headers) as response:
            raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}


class _Chat:
    def __init__(self, client: CloudMesh) -> None:
        self._client = client

    def create(
        self,
        model: str,
        messages: list[dict[str, str]],
        max_tokens: int | None = None,
        temperature: float | None = None,
        idempotency_key: str | None = None,
    ) -> ChatResponse:
        """A single, non-streaming completion.

        Pass ``model="auto"`` to let the routing engine score every
        candidate on cost, latency and reliability. An explicit model is
        never silently substituted.
        """
        body: dict[str, Any] = {"model": model, "messages": messages, "stream": False}
        if max_tokens is not None:
            body["maxTokens"] = max_tokens
        if temperature is not None:
            body["temperature"] = temperature

        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        data = self._client._request_json("POST", "/v1/chat", body, headers)

        usage_raw = data.get("usage") or {}
        prompt_tokens = usage_raw.get("promptTokens", 0)
        completion_tokens = usage_raw.get("completionTokens", 0)
        return ChatResponse(
            id=data.get("id", ""),
            model=data.get("model", model),
            provider=data.get("provider", ""),
            content=(data.get("message") or {}).get("content", ""),
            finish_reason=data.get("finishReason"),
            usage=Usage(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                # The API sends the two components but no total.
                total_tokens=prompt_tokens + completion_tokens,
            ),
            cached=bool(data.get("cached", False)),
            raw=data,
        )

    def stream(
        self,
        model: str,
        messages: list[dict[str, str]],
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> Iterator[ChatChunk]:
        """Yields deltas as they are generated.

        Handles the SSE framing, so callers never deal with ``data:`` lines
        or the ``[DONE]`` sentinel.
        """
        body: dict[str, Any] = {"model": model, "messages": messages, "stream": True}
        if max_tokens is not None:
            body["maxTokens"] = max_tokens
        if temperature is not None:
            body["temperature"] = temperature

        with self._client._open("POST", "/v1/chat", body, {"Accept": "text/event-stream"}) as resp:
            for raw_line in resp:
                line = raw_line.decode("utf-8").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[len("data:") :].strip()
                if payload == "[DONE]":
                    return
                if not payload:
                    continue
                try:
                    parsed = json.loads(payload)
                except json.JSONDecodeError:
                    # A malformed frame is skipped rather than killing the
                    # stream — the remaining tokens are still useful.
                    continue
                # The wire field is `delta`; this SDK exposes it as
                # `text`. A terminal frame carries `done: true` and no
                # delta, so it is skipped — `[DONE]` ends the stream.
                delta = parsed.get("delta")
                if delta:
                    yield ChatChunk(text=delta)


class _Models:
    def __init__(self, client: CloudMesh) -> None:
        self._client = client

    def list(self) -> list[dict[str, Any]]:
        return self._client._request_json("GET", "/v1/models").get("models", [])


class _Jobs:
    def __init__(self, client: CloudMesh) -> None:
        self._client = client

    def create(
        self, type: str, payload: Any, priority: str | None = None
    ) -> dict[str, Any]:  # noqa: A002 - matches the API's own field name
        body: dict[str, Any] = {"type": type, "payload": payload}
        if priority:
            body["priority"] = priority
        return self._client._request_json("POST", "/v1/jobs", body)

    def get(self, job_id: str) -> dict[str, Any]:
        # Quoted so a crafted id cannot escape the path segment.
        return self._client._request_json(
            "GET", f"/v1/jobs/{urllib.parse.quote(job_id, safe='')}"
        )

    def list(self, status: str | None = None, limit: int | None = None) -> list[dict[str, Any]]:
        query: dict[str, Any] = {}
        if status:
            query["status"] = status
        if limit is not None:
            query["limit"] = limit
        suffix = f"?{urllib.parse.urlencode(query)}" if query else ""
        return self._client._request_json("GET", f"/v1/jobs{suffix}").get("jobs", [])

    def replay(self, job_id: str) -> dict[str, Any]:
        return self._client._request_json(
            "POST", f"/v1/jobs/{urllib.parse.quote(job_id, safe='')}/replay"
        )
