# @cloudmesh/sdk

Official JavaScript/TypeScript client for the [CloudMesh](../../README.md) AI
gateway. Fully typed, zero runtime dependencies, works in Node 20+ and any
modern browser or edge runtime with `fetch`.

## Install

```bash
npm install @cloudmesh/sdk
```

## Quickstart

```ts
import CloudMesh from "@cloudmesh/sdk";

const cm = new CloudMesh({
  apiKey: process.env.CLOUDMESH_API_KEY!,
  baseUrl: "https://your-gateway.example.com",
});

const response = await cm.chat.create({
  model: "auto",
  messages: [{ role: "user", content: "Explain circuit breakers in one sentence." }],
});

console.log(response.message.content);
console.log(`${response.usage.totalTokens} tokens via ${response.model}`);
```

Never hardcode the key. It is shown exactly once, at creation — CloudMesh
stores only a SHA-256 hash and cannot recover it for you.

## Streaming

`chunk.text` is the increment, not the running total. The SDK handles the
SSE framing, so you never see `data:` lines or the `[DONE]` sentinel.

```ts
for await (const chunk of cm.chat.stream({
  model: "auto",
  messages: [{ role: "user", content: "Write a haiku about databases." }],
})) {
  process.stdout.write(chunk.text);
}
```

## `model: "auto"`

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

```ts
await cm.chat.create({
  model: "auto",
  messages,
  idempotencyKey: `order-${orderId}`,
});
```

## Errors

Branch on the class, or on `err.code` — the stable machine-readable field.
Messages are human-readable and may change.

```ts
import { RateLimitError, BudgetExceededError } from "@cloudmesh/sdk";

try {
  await cm.chat.create({ model: "auto", messages });
} catch (err) {
  if (err instanceof RateLimitError) {
    console.warn(`Rate limited; retry in ${err.retryAfterSeconds}s`);
  } else if (err instanceof BudgetExceededError) {
    console.error("Budget exhausted — top up in the dashboard.");
  } else {
    throw err;
  }
}
```

| Class                 | Status | Meaning                                   |
| --------------------- | ------ | ----------------------------------------- |
| `InvalidRequestError` | 400    | Body or query failed validation           |
| `AuthenticationError` | 401    | Missing, malformed, or revoked key        |
| `BudgetExceededError` | 402    | Organization budget exhausted             |
| `NotFoundError`       | 404    | No such resource, or another org's        |
| `RateLimitError`      | 429    | Rate limited; see `retryAfterSeconds`     |
| `ServiceError`        | 5xx    | Provider failed, or all circuits open     |
| `ConnectionError`     | —      | No response: DNS, refused, timeout, abort |

## Async jobs

```ts
const job = await cm.jobs.create({
  type: "bulk_chat",
  payload: { model: "auto", prompts: ["one", "two", "three"] },
  priority: "HIGH",
});

const status = await cm.jobs.get(job.id);
console.log(status.status, status.progress);
```

## Cancellation and timeouts

Every method accepts an `AbortSignal`. It is combined with the client's own
timeout, so whichever fires first wins:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

await cm.chat.create({ model: "auto", messages, signal: controller.signal });
```

## Options

| Option       | Default                 | Notes                     |
| ------------ | ----------------------- | ------------------------- |
| `apiKey`     | —                       | Required                  |
| `baseUrl`    | `http://localhost:3001` | Your gateway's public URL |
| `timeoutMs`  | `60000`                 | Per request               |
| `maxRetries` | `2`                     | Retries on 429/5xx only   |
| `fetch`      | global `fetch`          | Injectable for tests      |
