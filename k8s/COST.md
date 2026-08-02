# CloudMesh — infrastructure cost estimate

This is the cost of _keeping the platform up_ — separate from the
per-token LLM costs billed to orgs, which flow through Phase 7's billing
system, not this infrastructure.

## What was actually built here

`k8s/`'s manifests deliberately take the design doc's own "cheaper path
for a learning build" — self-hosted, single-instance Postgres/Redis/NATS
StatefulSets, not the design doc's literal HA cluster diagram (Postgres
primary+replica, Redis Cluster 3M+3R). See CLAUDE.md's Phase 14 notes for
why: standing up real streaming replication / cluster-mode Redis in raw
StatefulSet YAML is a substantial undertaking the design doc's own text
already treats as optional ("real trade-offs (no HA, manual failover) but
enough to run every phase and load-test it").

## Baseline resource footprint (HPAs at `minReplicas`, no autoscale triggered)

| Component              | Replicas              | CPU request   | Memory request | Storage  |
| ---------------------- | --------------------- | ------------- | -------------- | -------- |
| postgres               | 1                     | 250m          | 512Mi          | 20Gi PVC |
| redis                  | 1                     | 100m          | 256Mi          | 5Gi PVC  |
| nats                   | 1                     | 100m          | 128Mi          | 5Gi PVC  |
| api                    | 2 (HPA 2–10, 70% CPU) | 500m          | 512Mi          | —        |
| gateway                | 2 (HPA 2–20, 60% CPU) | 500m          | 512Mi          | —        |
| gateway-worker         | 2                     | 500m          | 512Mi          | —        |
| gateway-consumers      | 1                     | 150m          | 256Mi          | —        |
| gateway-webhook-worker | 2                     | 150m          | 512Mi          | —        |
| dashboard              | 2                     | 300m          | 512Mi          | —        |
| **Total (baseline)**   |                       | **~2.6 vCPU** | **~3.7Gi**     | **30Gi** |

At the gateway's HPA ceiling (20 replicas under sustained load), add
roughly 18 × (250m / 256Mi) ≈ 4.5 vCPU / 4.5Gi more, transient.

## Cheap path (what this manifest set is sized for) — self-hosted k3s

Matches the design doc's own "learning build" framing:

```
Single VM (Hetzner/DO/similar, 8GB, 4vCPU) running k3s        ~$40–$48/mo
  → fits the baseline footprint above with headroom for the
    HPA ceiling during a load test, not for it sustained 24/7
Object storage for Postgres backups (pg_dump → S3-compatible)  ~$1–$5/mo
Load balancer / ingress (if not using the VM's public IP direct) ~$0–$10/mo
Observability (Phase 12's Grafana stack, self-hosted in-cluster)  $0 (already counted in the VM)
```

**Total: roughly $45–$65/month.** Real trade-offs versus the managed
path below: no automatic Postgres/Redis failover, backups are your own
cron job, and a node failure takes the whole cluster down until it's
replaced — accepted here the same way the design doc accepts it for a
learning/portfolio build, not a revenue-bearing production one.

## Managed path (recommended before any real customer traffic)

Swap `10-postgres.yaml`/`11-redis.yaml`'s StatefulSets for managed
equivalents — the application code doesn't care, since it only ever talks
to `DATABASE_URL`/`REDIS_URL` connection strings, never anything
StatefulSet-specific:

```
Postgres (RDS db.t4g.medium, +1 read replica)   ~$110/mo
Redis (ElastiCache cache.t4g.small ×3)          ~$90/mo
NATS JetStream (small VM, still self-hosted —
  no mainstream managed NATS offering)           ~$25/mo
k8s nodes (2× t3.medium, autoscale to 4–5
  for the gateway HPA's ceiling)                 ~$60–$150/mo
Load balancer + egress                           ~$25/mo
Observability (self-hosted Grafana stack,
  runs in-cluster — Phase 12)                    ~$0
```

**Total: roughly $310–$400/month** at low-to-moderate traffic — close to
the design doc's own $310–$370 estimate; the small delta is this build's
extra Deployments (separate worker/consumers/webhook-worker processes,
Phase 9–11) the original spec's diagram didn't itemize individually.

## Why this belongs in the repo, not just a comment

"Production-ready" implies someone is paying for it every month whether or
not a customer sends a request. Sizing this now (from the manifests this
repo actually ships, not a hypothetical) is what makes a future load test
able to answer "what does N req/s cost," not just "does it survive N
req/s."
