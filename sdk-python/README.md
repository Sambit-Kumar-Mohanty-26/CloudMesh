# cloudmesh-sdk

Official Python client for the CloudMesh AI gateway.

**Zero runtime dependencies** — built on `urllib` from the standard library,
so it installs anywhere without dependency-resolution conflicts. Requires
Python 3.9+.

## Install

```bash
pip install cloudmesh-sdk
```

## Quickstart

```python
import os
from cloudmesh import CloudMesh

cm = CloudMesh(
    api_key=os.environ["CLOUDMESH_API_KEY"],
    base_url="https://your-gateway.example.com",
)

response = cm.chat.create(
    model="auto",
    messages=[{"role": "user", "content": "Explain circuit breakers in one sentence."}],
)

print(response.content)
print(f"{response.usage.total_tokens} tokens via {response.model}")
```

Never hardcode the key. It is shown exactly once, at creation — CloudMesh
stores only a SHA-256 hash and cannot recover it for you.

## Streaming

`chunk.text` is the increment, not the running total. The SDK handles the
SSE framing, so you never see `data:` lines or the `[DONE]` sentinel.

```python
for chunk in cm.chat.stream(
    model="auto",
    messages=[{"role": "user", "content": "Write a haiku about databases."}],
):
    print(chunk.text, end="", flush=True)
```

## `model="auto"`

Routes to the best candidate scored on cost, latency and reliability, and
skips any provider whose circuit breaker is open.

An **explicit** model is never silently substituted — if `gpt-4o-mini` is
unavailable you get a `ServiceError`, not a different model's answer. That
is deliberate: silently swapping models changes your output distribution
and your costs without telling you.

## Retries and idempotency

Retries are automatic on `429` and `5xx` only, honouring `Retry-After`.
`400`/`401`/`402` are never retried — they would fail identically forever,
and retrying a `402` just hammers a budget that is already exhausted.

For non-idempotent work, pass a key so a retry can't double-bill you:

```python
cm.chat.create(
    model="auto",
    messages=messages,
    idempotency_key=f"order-{order_id}",
)
```

## Errors

Catch the class, or switch on `err.code` — the stable machine-readable
field. Messages are human-readable and may change.

```python
from cloudmesh import RateLimitError, BudgetExceededError

try:
    cm.chat.create(model="auto", messages=messages)
except RateLimitError as err:
    print(f"Rate limited; retry in {err.retry_after_seconds}s")
except BudgetExceededError:
    print("Budget exhausted — top up in the dashboard.")
```

| Class                      | Status | Meaning                                 |
| -------------------------- | ------ | --------------------------------------- |
| `InvalidRequestError`      | 400    | Body or query failed validation         |
| `AuthenticationError`      | 401    | Missing, malformed, or revoked key      |
| `BudgetExceededError`      | 402    | Organization budget exhausted           |
| `NotFoundError`            | 404    | No such resource, or another org's      |
| `RateLimitError`           | 429    | Rate limited; see `retry_after_seconds` |
| `ServiceError`             | 5xx    | Provider failed, or all circuits open   |
| `CloudMeshConnectionError` | —      | No response: DNS, refused, timeout      |

`CloudMeshConnectionError` is named to avoid shadowing Python's builtin
`ConnectionError`.

## Async jobs

```python
job = cm.jobs.create(
    type="bulk_chat",
    payload={"model": "auto", "prompts": ["one", "two", "three"]},
    priority="HIGH",
)

status = cm.jobs.get(job["id"])
print(status["status"], status["progress"])
```

## Options

| Argument      | Default                 | Notes                     |
| ------------- | ----------------------- | ------------------------- |
| `api_key`     | —                       | Required                  |
| `base_url`    | `http://localhost:3001` | Your gateway's public URL |
| `timeout`     | `60.0`                  | Seconds, per request      |
| `max_retries` | `2`                     | Retries on 429/5xx only   |

## Development

```bash
pip install pytest
python -m pytest tests/ -q
```

Tests run against a real `http.server` on loopback rather than a mocked
transport, so SSE framing, headers and retry behaviour are genuinely
exercised.
