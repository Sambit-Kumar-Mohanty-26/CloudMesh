# CloudMesh

An AI gateway platform — auth, rate limiting, semantic caching, routing,
billing, and observability for teams building on top of LLM providers, so
individual apps don't reimplement that plumbing.

## Repo layout

```
apps/api/                 Fastify service: auth, API key management, billing config,
                             invoices, Stripe webhook receiver, webhook endpoint registration,
                             usage analytics aggregation, live-stats WebSocket relay
apps/gateway/              Fastify service: unified /v1/chat across providers — streaming,
                             idempotency, rate limiting, circuit breaker + retry, semantic cache
                             + request dedup, budget enforcement + usage billing, intelligent
                             routing (scoring, named presets, A/B), async jobs + WebSocket progress,
                             outbound webhook dispatch + email notifications, live-stats publisher
apps/dashboard/             Next.js developer portal — API keys, usage charts, request logs,
                             budget/webhook settings, live API playground (BFF over apps/api)
packages/db/                Prisma schema, migrations, shared DB client
packages/auth/               Shared API-key auth (resolveApiKey) used by both apps/*
packages/billing/             Shared budget-status logic (getBudgetStatus) used by both apps/*
packages/jobs/                BullMQ queue, worker pool, DLQ + replay, progress pub/sub
packages/events/              NATS JetStream bus: event schema, publisher, durable subscribers
packages/outbox/               Transactional outbox (write + poll-and-publish), shared by both apps/*
packages/webhooks/             SSRF guard, HMAC signing, BullMQ delivery queue + worker, registration
packages/rate-limiter/        4 distributed rate-limiting algorithms (Redis + Lua)
packages/circuit-breaker/      Circuit breaker (3-state, Redis + Lua) + backoff retry
packages/telemetry/            OpenTelemetry SDK bootstrap, span helper, trace/log correlation
packages/metrics/              Prometheus metrics (prom-client) + /metrics route
docker/                          Prometheus scrape config + Grafana datasource/dashboard provisioning
runbooks/                        On-call runbooks for the three alerts wired against real metrics
k8s/                              Kubernetes manifests, infra cost estimate (see k8s/README.md)
packages/openapi/                 OpenAPI 3.1 document, generated from the real Zod schemas
packages/sdk/                     official JavaScript/TypeScript SDK (see its README)
sdk-python/                       official Python SDK (see its README)
notes/                          Original project spec (read-only reference)
```

Each deployable app (`apps/api`, `apps/gateway`, `apps/dashboard`) has its
own `Dockerfile` at its root — see `k8s/README.md` for how they're built
and deployed.

## Prerequisites

- Node.js 22+ (see `.nvmrc`)
- Docker (for local Postgres + Redis)

## Setup

```bash
npm install

# Start Postgres (with pgvector) + Redis
docker compose up -d

# Apply migrations, generate the Prisma client
npm run db:migrate

# Optional: seed a sample org/user/API key
npm run db:seed
```

Copy the env examples. `apps/api` needs a real `JWT_SECRET` (32+ chars);
`apps/gateway` needs at least one provider key to call a real LLM, or set
`ENABLE_MOCK_PROVIDER=true` to exercise the gateway with a canned
no-network `mock-echo` model instead:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/gateway/.env.example apps/gateway/.env
cp packages/db/.env.example packages/db/.env
```

## Running the services

```bash
npm run dev          # apps/api on :3000, with reload
curl http://localhost:3000/health

npm run dev --workspace=@cloudmesh/gateway   # apps/gateway on :3001
curl http://localhost:3001/health
```

Async jobs (Phase 9) are drained by a **separate worker process** — the API
only enqueues, so nothing runs until at least one worker is up. Run as many
as you want against the same Redis; they share the queue:

```bash
npm run worker --workspace=@cloudmesh/gateway
```

Platform events (Phase 10) drain from the transactional outbox onto NATS
JetStream. The five subscribers (analytics, audit, billing, webhook
dispatch, email) run in their own process:

```bash
npm run consumers --workspace=@cloudmesh/gateway
```

Without `NATS_URL` set the gateway logs outbox events instead of publishing
them (events still accumulate safely in the outbox); the consumer process
requires it and exits without it.

Webhooks (Phase 11) are two-stage: the consumer process above only
_enqueues_ a delivery per subscribed endpoint onto a separate BullMQ queue
(SSRF-checked again at registration in `apps/api`'s `POST /webhooks`, and
re-checked here on every delivery attempt, since DNS can rebind in between).
A **separate worker process** actually re-checks the target, HMAC-signs the
payload, and delivers it, following the design doc's literal 1s/5s/30s/
5min/30min retry schedule on 5xx:

```bash
npm run webhook-worker --workspace=@cloudmesh/gateway
```

Email notifications (job completions, budget warnings, API key events) go
through Resend and are optional — set `RESEND_API_KEY` in
`apps/gateway/.env` to enable them; unset, the email subscriber's sends fail
individually (logged, swallowed) without blocking the consumer process.

## Observability

`docker compose up -d` also starts Jaeger, Prometheus, and Grafana
alongside Postgres/Redis/NATS:

- **Jaeger UI** — <http://localhost:16686> (traces)
- **Prometheus** — <http://localhost:9090> (raw metrics/targets)
- **Grafana** — <http://localhost:3300> (dashboards; anonymous admin
  access, local dev only)

Both apps run every process through a `src/instrument.ts` bootstrap
(`npm run dev`/`start`/`worker`/`consumers`/`webhook-worker` all point at
it now, not the old entry files directly) that starts the OpenTelemetry SDK
**before** anything else is imported — required for its `http`/`undici`/
`ioredis` auto-instrumentation to actually patch those modules; starting it
any later (even as the first line of `server.ts`) is too late, since ES
module imports are hoisted and evaluated before that line would run. Traces
export to Jaeger's OTLP receiver (`http://localhost:4318`, both apps'
default) — override with `OTEL_EXPORTER_OTLP_ENDPOINT` to point at a real
collector elsewhere.

Every service also exposes `GET /metrics` (Prometheus exposition format,
unauthenticated — meant to be reached only from inside a scrape network,
not exposed publicly), which the Prometheus container scrapes via
`host.docker.internal` every 15s. `docker/grafana/dashboards/` has four
provisioned dashboards (Overview, Per-Org, Provider, Cache); `runbooks/`
has the on-call runbook for each of the three alerts the design doc calls
for, each referencing a real, wired metric.

## Developer dashboard

```bash
npm run dev --workspace=@cloudmesh/dashboard   # apps/dashboard on :3002
```

A Next.js 16 App Router portal in front of apps/api and apps/gateway — API
key management, usage charts, a request-log explorer, budget/webhook
settings, and a live API playground (Monaco editor + real SSE streaming
against `POST /v1/chat`). It's a BFF, not a direct browser-to-service
client: every page/action calls apps/api server-to-server, carrying the
session in the dashboard's own cookie (see CLAUDE.md's Phase 13 notes for
why apps/api's refresh cookie can't cross origins directly). Points at
`http://localhost:3000`/`:3001` by default — override with
`CLOUDMESH_API_URL`/`CLOUDMESH_GATEWAY_URL` if those run elsewhere.

The live "requests per second / p99 / errors" feed on the dashboard is a
real Redis pub/sub round trip: apps/gateway computes it per-org
(`lib/orgLiveStats.ts`) and publishes every 5s; apps/api's `WS
/ws/live-stats` only relays it to the browser.

## Testing

Integration tests hit a real Postgres + Redis + NATS (the same
`docker compose` stack), not mocks — make sure it is running first.

```bash
npm test                       # every workspace
npm test --workspace=@cloudmesh/api   # just the API
```

## API reference

The gateway serves its own OpenAPI 3.1 document and an interactive Swagger
UI:

| URL             | What                          |
| --------------- | ----------------------------- |
| `/openapi.json` | The OpenAPI 3.1 document      |
| `/docs`         | Swagger UI, with "Try it out" |

Both are unauthenticated on purpose — a developer needs to read the docs
_before_ they have credentials, and the document contains no tenant data.

The spec is generated from the same Zod schemas the route handlers validate
with (via Zod 4's native `z.toJSONSchema()`), so a documented request body
is by construction the one the server enforces. Set `PUBLIC_BASE_URL` so
"Try it out" targets your real host rather than localhost.

## SDKs

```bash
npm install @cloudmesh/sdk     # JavaScript / TypeScript
pip install cloudmesh-sdk      # Python
```

Both cover chat (including streaming), model discovery and async jobs, map
HTTP failures onto typed errors, and retry `429`/`5xx` while honouring
`Retry-After`. See `packages/sdk/README.md` and `sdk-python/README.md`.

## Quality gates

```bash
npm run typecheck
npm run lint
npm run format:check
```

All three, plus the test suite, are expected to be clean before a change is
considered done.

`npm audit --omit=dev --audit-level=high` reports 0 vulnerabilities. The
three findings inside `apps/dashboard`'s dependencies first hit in Phase 13
(`dompurify` via `monaco-editor`; `postcss`/`sharp` bundled inside
`next@16.2.12` itself) are fixed via root `package.json`'s `overrides` —
`sharp` needed both a flat top-level entry and the nested `next.sharp`
entry, since it's declared under `next`'s `optionalDependencies`. See
CLAUDE.md's Phase 13 and Phase 14 notes for the full story.

## Database

`packages/db` connects two ways:

- `DATABASE_URL` — the Postgres superuser. Migrations, seeding, test
  fixtures only. Bypasses Row-Level Security.
- `APP_DATABASE_URL` — the non-superuser `cloudmesh_app` role. This is what
  running services use, and it's RLS-bound.

See `packages/db/ER_DIAGRAM.md` for the schema.
