# CloudMesh

An AI gateway platform — auth, rate limiting, semantic caching, routing,
billing, and observability for teams building on top of LLM providers, so
individual apps don't reimplement that plumbing.

## Repo layout

```
apps/api/                 Fastify service: auth, API key management
apps/gateway/              Fastify service: unified /v1/chat across providers — streaming,
                             idempotency, rate limiting, circuit breaker + retry, fallback
packages/db/                Prisma schema, migrations, shared DB client
packages/auth/               Shared API-key auth (resolveApiKey) used by both apps/*
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

## Testing

Integration tests hit a real Postgres + Redis (the same `docker compose`
stack), not mocks — make sure it's running first.

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
