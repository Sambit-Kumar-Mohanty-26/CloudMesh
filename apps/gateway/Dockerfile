# syntax=docker/dockerfile:1
#
# Build context is the MONOREPO ROOT, not this directory — see apps/api's
# Dockerfile for why. Build with:
#   docker build -f apps/gateway/Dockerfile -t cloudmesh-gateway .
#
# One image, four entry points (server/worker/consumers/webhookWorker) —
# the same split this codebase already runs as separate `npm run` scripts
# locally (see README's "Running the services"). Which one a given
# container runs is a k8s Deployment's `command`/`args` override, not a
# separate image per entry point.
FROM node:22-slim AS base
WORKDIR /app

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
COPY apps/gateway/package.json apps/gateway/package.json

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
COPY apps/gateway apps/gateway

RUN npm run generate --workspace=@cloudmesh/db

ENV NODE_ENV=production
EXPOSE 3001

# Default to the HTTP server; k8s Deployments for the worker/consumers/
# webhook-worker processes override this with their own `args`.
CMD ["npx", "tsx", "apps/gateway/src/instrument.ts", "server"]
