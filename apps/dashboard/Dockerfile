# syntax=docker/dockerfile:1
#
# Build context is the MONOREPO ROOT, not this directory — same reason as
# apps/api's Dockerfile (npm workspaces needs the whole tree's manifests to
# resolve correctly). Build with:
#   docker build -f apps/dashboard/Dockerfile -t cloudmesh-dashboard .

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json /app/package-lock.json ./
COPY apps/dashboard apps/dashboard
RUN npm run build --workspace=@cloudmesh/dashboard

# Next's `output: "standalone"` trace only includes what it found
# reachable from actual imports — static assets are deliberately excluded
# from that trace and have to be copied in by hand, per Next's own
# documented standalone deployment steps. No public/ directory exists in
# this app (nothing to copy there).
RUN cp -r apps/dashboard/.next/static apps/dashboard/.next/standalone/apps/dashboard/.next/static

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3002

# This image's CMD runs `node server.js` directly — npm/npx/yarn/corepack
# are never invoked at runtime (unlike apps/api and apps/gateway, which
# start via `npx tsx` and pin a patched npm instead — see those
# Dockerfiles). node:22-slim ships all of these bundled regardless, and
# npm's own bundled dependencies (tar, sigstore) carry real CVEs, so they
# come out of the final image entirely rather than staying as unused,
# vulnerable dead weight.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /opt/yarn-v* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg /usr/local/bin/corepack

COPY --from=builder /app/apps/dashboard/.next/standalone ./
EXPOSE 3002

# The standalone server.js already resolves CLOUDMESH_API_URL/
# CLOUDMESH_GATEWAY_URL from the real container environment (see lib/
# env.ts) — nothing to bake in here.
CMD ["node", "apps/dashboard/server.js"]
