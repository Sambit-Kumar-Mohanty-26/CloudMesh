# CloudMesh

An AI gateway platform — auth, rate limiting, semantic caching, routing,
billing, and observability for teams building on top of LLM providers, so
individual apps don't reimplement that plumbing.

## Repo layout

```
apps/api/                 Fastify service: auth, API key management, billing config,
                             invoices, Stripe webhook receiver, webhook endpoint registration
apps/gateway/              Fastify service: unified /v1/chat across providers — streaming,
                             idempotency, rate limiting, circuit breaker + retry, semantic cache
                             + request dedup, budget enforcement + usage billing, intelligent
                             routing (scoring, named presets, A/B), async jobs + WebSocket progress,
                             outbound webhook dispatch + email notifications
packages/db/                Prisma schema, migrations, shared DB client
packages/auth/               Shared API-key auth (resolveApiKey) used by both apps/*
packages/billing/             Shared budget-status logic (getBudgetStatus) used by both apps/*
packages/jobs/                BullMQ queue, worker pool, DLQ + replay, progress pub/sub
packages/events/              NATS JetStream bus: event schema, publisher, durable subscribers
packages/outbox/               Transactional outbox (write + poll-and-publish), shared by both apps/*
packages/webhooks/             SSRF guard, HMAC signing, BullMQ delivery queue + worker, registration
packages/rate-limiter/        4 distributed rate-limiting algorithms (Redis + Lua)
packages/circuit-breaker/      Circuit breaker (3-state, Redis + Lua) + backoff retry
notes/                          Original project spec (read-only reference)
```

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

## Testing

Integration tests hit a real Postgres + Redis + NATS (the same
`docker compose` stack), not mocks — make sure it is running first.

```bash
npm test                       # every workspace
npm test --workspace=@cloudmesh/api   # just the API
```

## Quality gates

```bash
npm run typecheck
npm run lint
npm run format:check
```

All three, plus the test suite, are expected to be clean before a change is
considered done.

## Database

`packages/db` connects two ways:

- `DATABASE_URL` — the Postgres superuser. Migrations, seeding, test
  fixtures only. Bypasses Row-Level Security.
- `APP_DATABASE_URL` — the non-superuser `cloudmesh_app` role. This is what
  running services use, and it's RLS-bound.

See `packages/db/ER_DIAGRAM.md` for the schema.
