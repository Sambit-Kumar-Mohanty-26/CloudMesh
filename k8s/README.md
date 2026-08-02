# CloudMesh — Kubernetes manifests

Phase 14's deployment target. Plain Kustomize-composed manifests, not Helm
— this repo has no templating need beyond what `envFrom`/Secret injection
already covers.

## What's here

| File                             | What                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `00-namespace.yaml`              | the `cloudmesh` namespace everything else lives in                                            |
| `01-configmap.yaml`              | non-secret config (Service DNS URLs, feature toggles)                                         |
| `02-secret.example.yaml`         | **template only** — see its header comment                                                    |
| `10-postgres.yaml`               | single-instance Postgres StatefulSet (pgvector) + headless Service                            |
| `11-redis.yaml`                  | single-instance Redis StatefulSet + headless Service                                          |
| `12-nats.yaml`                   | single-instance NATS JetStream StatefulSet + Service                                          |
| `15-migrate-job.yaml`            | one-shot `prisma migrate deploy` Job — **not** in the default kustomization, applied manually |
| `20-api.yaml`                    | apps/api Deployment + Service + HPA (min 2, max 10, 70% CPU)                                  |
| `21-gateway.yaml`                | apps/gateway HTTP server Deployment + Service + HPA (min 2, max 20, 60% CPU)                  |
| `22-gateway-worker.yaml`         | Phase 9 async job worker (same image, different `command`)                                    |
| `23-gateway-consumers.yaml`      | Phase 10/11 NATS subscribers (same image, different `command`)                                |
| `24-gateway-webhook-worker.yaml` | Phase 11 webhook delivery worker (same image, different `command`)                            |
| `30-dashboard.yaml`              | apps/dashboard Deployment + Service, static 2 replicas, no HPA                                |
| `40-ingress.yaml`                | nginx Ingress routing by each service's _actual_ registered routes                            |

## What was and wasn't possible to verify here

**No live Kubernetes cluster exists in this environment** — `kubectl`'s
client is installed but has no reachable server (no kind/minikube/k3d
either), the same "no live credentials" situation as every external
dependency in this codebase (LLM providers, Stripe, Resend). What _was_
verified for real:

- Every manifest renders correctly through `kubectl kustomize k8s/`
  (structural validity, correct cross-references, no duplicate resources)
  — see CLAUDE.md's Phase 14 notes for why this is the strongest check
  possible without a server (`kubectl apply --dry-run=client` itself
  requires live API discovery from a server even in dry-run mode; it is
  not purely client-side despite the name).
- The three Dockerfiles build against this repo's actual monorepo
  structure and match how each service already runs in `npm run
dev`/`start` locally.

What's **not** verified: an actual `kubectl apply` against a running
cluster, a real rolling deployment, HPA actually scaling under load, or
the Ingress actually routing traffic. Validate all of that against a real
cluster (even a local `kind`/`k3d` one) before trusting this for a real
deployment.

## Applying this (once you have a real cluster)

```bash
# 1. Build and push images (see .github/workflows/deploy.yml for the CI
#    version of this — these tags are for a manual/local run)
docker build -f apps/api/Dockerfile       -t <registry>/cloudmesh-api:<tag>       .
docker build -f apps/gateway/Dockerfile   -t <registry>/cloudmesh-gateway:<tag>   .
docker build -f apps/dashboard/Dockerfile -t <registry>/cloudmesh-dashboard:<tag> .
docker push <registry>/cloudmesh-api:<tag>
docker push <registry>/cloudmesh-gateway:<tag>
docker push <registry>/cloudmesh-dashboard:<tag>

# 2. Point the manifests at your real images — the checked-in files use
#    :latest placeholders for readability; a real rollout should pin an
#    immutable tag/digest instead (see kustomize's `images:` transformer,
#    or just sed the three image: lines before applying).

# 3. Namespace + config first
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/01-configmap.yaml

# 4. Real secrets — do NOT apply 02-secret.example.yaml as-is (see its
#    header). Either fill in a gitignored copy, or:
kubectl create secret generic cloudmesh-secrets -n cloudmesh \
  --from-literal=POSTGRES_PASSWORD='...' \
  --from-literal=DATABASE_URL='postgresql://cloudmesh:...@postgres:5432/cloudmesh' \
  --from-literal=APP_DATABASE_URL='postgresql://cloudmesh_app:cloudmesh_app@postgres:5432/cloudmesh' \
  --from-literal=JWT_SECRET='...'

# 5. Stateful infra, then wait for Postgres to actually be ready
kubectl apply -f k8s/10-postgres.yaml -f k8s/11-redis.yaml -f k8s/12-nats.yaml
kubectl wait --for=condition=ready pod -l app=postgres -n cloudmesh --timeout=120s

# 6. Migrations — once, before any app Deployment starts
kubectl apply -f k8s/15-migrate-job.yaml
kubectl wait --for=condition=complete job/migrate -n cloudmesh --timeout=120s

# 7. Everything else
kubectl apply -f k8s/20-api.yaml -f k8s/21-gateway.yaml -f k8s/22-gateway-worker.yaml \
  -f k8s/23-gateway-consumers.yaml -f k8s/24-gateway-webhook-worker.yaml \
  -f k8s/30-dashboard.yaml -f k8s/40-ingress.yaml

kubectl rollout status deployment/api deployment/gateway deployment/dashboard -n cloudmesh
```

See `COST.md` for the monthly infrastructure cost estimate this shape
implies, and CLAUDE.md's Phase 14 notes for the design decisions (single-
instance stateful services vs. the design doc's literal HA cluster
diagram, why observability/Jaeger/Prometheus/Grafana aren't in this
manifest set, the Ingress path-routing rationale).
