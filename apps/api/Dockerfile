# syntax=docker/dockerfile:1
#
# Build context is the MONOREPO ROOT, not this directory — this Dockerfile
# needs every workspace's package.json to let `npm ci` resolve the
# workspace link tree correctly. Build with:
#   docker build -f apps/api/Dockerfile -t cloudmesh-api .
FROM node:22-slim AS base
WORKDIR /app

# Manifests only, copied before source — installs the exact same
# dependency tree regardless of which app's Dockerfile runs, so this layer
# is cache-shared across api/gateway/dashboard image builds and only
# re-runs when a package.json actually changes, not on every source edit.
COPY package.json package-lock.json ./
COPY packages/auth/package.json packages/auth/package.json
COPY packages/billing/package.json packages/billing/package.json
COPY packages/circuit-breaker/package.json packages/circuit-breaker/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/metrics/package.json packages/metrics/package.json
COPY packages/outbox/package.json packages/outbox/package.json
COPY packages/rate-limiter/package.json packages/rate-limiter/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
COPY packages/webhooks/package.json packages/webhooks/package.json
COPY apps/api/package.json apps/api/package.json

# This service runs via tsx directly (no separate tsc build step — see
# CLAUDE.md's Phase 14 notes), so devDependencies (tsx, typescript) ARE
# runtime dependencies here, not build-only. `npm ci`, not `npm install`,
# for a reproducible install matching package-lock.json exactly.
RUN npm ci

COPY packages/auth packages/auth
COPY packages/billing packages/billing
COPY packages/circuit-breaker packages/circuit-breaker
COPY packages/db packages/db
COPY packages/events packages/events
COPY packages/jobs packages/jobs
COPY packages/metrics packages/metrics
COPY packages/outbox packages/outbox
COPY packages/rate-limiter packages/rate-limiter
COPY packages/telemetry packages/telemetry
COPY packages/webhooks packages/webhooks
COPY apps/api apps/api

# Prisma's generated client is schema-driven codegen, not checked into
# source — same `npm run generate` step CI runs before typecheck.
RUN npm run generate --workspace=@cloudmesh/db

ENV NODE_ENV=production
EXPOSE 3000

# No `--env-file` here, unlike the local `npm run start` script — real
# config comes from the container's actual environment (a k8s Secret/
# ConfigMap), not a baked-in .env file. `instrument.ts`, not `server.ts`
# directly: starts the OTel SDK before anything else is imported (see
# packages/telemetry's tracing.ts for why that ordering matters).
CMD ["npx", "tsx", "apps/api/src/instrument.ts"]
