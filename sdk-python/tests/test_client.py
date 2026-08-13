"""Tests for the CloudMesh Python SDK.

These run against a real ``http.server`` on loopback rather than a mocked
urllib, so the SSE framing, header handling and retry behaviour are
exercised end to end — a mocked transport would only prove the mock is
self-consistent.
"""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cloudmesh import (  # noqa: E402
    AuthenticationError,
    BudgetExceededError,
    CloudMesh,
    InvalidRequestError,
    NotFoundError,
    RateLimitError,
    ServiceError,
)

# Each entry: (status, headers, body-bytes). Popped in order per request.
RESPONSES: list[tuple[int, dict[str, str], bytes]] = []
REQUESTS: list[dict[str, object]] = []


class _Handler(BaseHTTPRequestHandler):
    def _handle(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        raw_body = self.rfile.read(length) if length else b""
        REQUESTS.append(
            {
                "path": self.path,
                "method": self.command,
                "headers": dict(self.headers),
                "body": raw_body.decode("utf-8") if raw_body else None,
            }
        )

        status, headers, body = RESPONSES.pop(0)
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _handle
    do_POST = _handle

    def log_message(self, *args: object) -> None:  # silence per-request logging
        return


@pytest.fixture()
def server():
    RESPONSES.clear()
    REQUESTS.clear()
    httpd = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


def queue_json(payload: object, status: int = 200, headers: dict[str, str] | None = None) -> None:
    RESPONSES.append(
        (status, {"Content-Type": "application/json", **(headers or {})}, json.dumps(payload).encode())
    )


def client(base_url: str, **kwargs) -> CloudMesh:
    kwargs.setdefault("max_retries", 2)
    return CloudMesh(api_key="cm_live_test", base_url=base_url, **kwargs)


# Captured verbatim from a real gateway response — the API sends
# `provider`/`finishReason` and does NOT send `usage.totalTokens`.
OK_CHAT = {
    "id": "c1",
    "provider": "mock",
    "model": "gemini-2.0-flash",
    "message": {"role": "assistant", "content": "hello"},
    "finishReason": "stop",
    "usage": {"promptTokens": 3, "completionTokens": 4},
}


def test_requires_api_key():
    with pytest.raises(ValueError, match="api_key is required"):
        CloudMesh(api_key="")


def test_sends_bearer_token_and_keeps_key_out_of_url(server):
    queue_json(OK_CHAT)
    client(server).chat.create(model="auto", messages=[{"role": "user", "content": "hi"}])

    assert REQUESTS[0]["headers"]["Authorization"] == "Bearer cm_live_test"
    # A key in a query string ends up in access logs and proxy history.
    assert "cm_live_test" not in str(REQUESTS[0]["path"])


def test_strips_trailing_slash_from_base_url(server):
    queue_json(OK_CHAT)
    client(server + "/").chat.create(model="auto", messages=[{"role": "user", "content": "hi"}])

    assert REQUESTS[0]["path"] == "/v1/chat"


def test_chat_create_parses_response_and_forces_non_streaming(server):
    queue_json(OK_CHAT)
    result = client(server).chat.create(
        model="auto", messages=[{"role": "user", "content": "hi"}]
    )

    assert result.content == "hello"
    assert result.model == "gemini-2.0-flash"
    assert result.provider == "mock"
    assert result.finish_reason == "stop"
    # The API sends only the two components; the SDK computes the total.
    assert result.usage.total_tokens == 7
    assert json.loads(REQUESTS[0]["body"])["stream"] is False


def test_idempotency_key_is_a_header_not_a_body_field(server):
    queue_json(OK_CHAT)
    client(server).chat.create(
        model="auto",
        messages=[{"role": "user", "content": "hi"}],
        idempotency_key="key-123",
    )

    assert REQUESTS[0]["headers"]["Idempotency-Key"] == "key-123"
    assert "idempotency_key" not in json.loads(REQUESTS[0]["body"])


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (400, InvalidRequestError),
        (401, AuthenticationError),
        (402, BudgetExceededError),
        (404, NotFoundError),
        (502, ServiceError),
    ],
)
def test_maps_status_codes_to_typed_errors(server, status, expected):
    queue_json({"error": "nope", "code": "SOME_CODE"}, status=status)

    with pytest.raises(expected):
        client(server, max_retries=0).models.list()


def test_preserves_the_servers_stable_code(server):
    queue_json({"error": "no budget", "code": "BUDGET_EXCEEDED"}, status=402)

    with pytest.raises(BudgetExceededError) as excinfo:
        client(server, max_retries=0).models.list()

    assert excinfo.value.code == "BUDGET_EXCEEDED"
    assert excinfo.value.status == 402


def test_non_json_error_body_still_raises_typed_error(server):
    RESPONSES.append((502, {"Content-Type": "text/html"}, b"<html>bad gateway</html>"))

    with pytest.raises(ServiceError):
        client(server, max_retries=0).models.list()


def test_retries_429_then_succeeds(server):
    queue_json({"error": "slow down", "code": "RATE_LIMITED"}, 429, {"Retry-After": "0"})
    queue_json(OK_CHAT)

    result = client(server).chat.create(
        model="auto", messages=[{"role": "user", "content": "hi"}]
    )

    assert result.content == "hello"
    assert len(REQUESTS) == 2


def test_does_not_retry_400(server):
    queue_json({"error": "bad", "code": "VALIDATION_ERROR"}, status=400)

    with pytest.raises(InvalidRequestError):
        client(server).models.list()

    assert len(REQUESTS) == 1


def test_does_not_retry_402_exhausted_budget(server):
    queue_json({"error": "no budget", "code": "BUDGET"}, status=402)

    with pytest.raises(BudgetExceededError):
        client(server).models.list()

    assert len(REQUESTS) == 1


def test_gives_up_after_max_retries(server):
    for _ in range(3):
        queue_json({"error": "boom", "code": "X"}, 503, {"Retry-After": "0"})

    with pytest.raises(ServiceError):
        client(server).models.list()

    assert len(REQUESTS) == 3  # initial + 2 retries


def test_rate_limit_error_exposes_retry_after(server):
    queue_json({"error": "slow", "code": "RATE_LIMITED"}, 429, {"Retry-After": "7"})

    with pytest.raises(RateLimitError) as excinfo:
        client(server, max_retries=0).models.list()

    assert excinfo.value.retry_after_seconds == 7


def test_stream_yields_deltas_and_stops_at_done(server):
    frames = (
        b'data: {"delta":"Hel"}\n\n'
        b'data: {"delta":"lo"}\n\n'
        b"data: [DONE]\n\n"
        b'data: {"delta":"never"}\n\n'
    )
    RESPONSES.append((200, {"Content-Type": "text/event-stream"}, frames))

    chunks = list(
        client(server).chat.stream(model="auto", messages=[{"role": "user", "content": "hi"}])
    )

    assert "".join(c.text for c in chunks) == "Hello"


def test_stream_skips_malformed_frame_without_dying(server):
    frames = b'data: {"delta":"a"}\n\ndata: {not json}\n\ndata: {"delta":"b"}\n\ndata: [DONE]\n\n'
    RESPONSES.append((200, {"Content-Type": "text/event-stream"}, frames))

    chunks = list(
        client(server).chat.stream(model="auto", messages=[{"role": "user", "content": "hi"}])
    )

    assert [c.text for c in chunks] == ["a", "b"]


def test_stream_surfaces_error_status_before_streaming(server):
    queue_json({"error": "nope", "code": "RATE_LIMITED"}, status=429)

    stream = client(server, max_retries=0).chat.stream(
        model="auto", messages=[{"role": "user", "content": "hi"}]
    )

    with pytest.raises(RateLimitError):
        next(stream)


def test_job_id_is_url_encoded_so_a_crafted_id_cannot_alter_the_path(server):
    queue_json({"id": "x"})
    client(server).jobs.get("../../admin")

    assert REQUESTS[0]["path"] == "/v1/jobs/..%2F..%2Fadmin"


def test_job_list_builds_query_only_from_supplied_filters(server):
    queue_json({"jobs": []})
    client(server).jobs.list(status="DEAD_LETTER", limit=5)
    assert REQUESTS[0]["path"] == "/v1/jobs?status=DEAD_LETTER&limit=5"

    queue_json({"jobs": []})
    client(server).jobs.list()
    assert REQUESTS[1]["path"] == "/v1/jobs"
