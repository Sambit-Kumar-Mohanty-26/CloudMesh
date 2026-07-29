# Runbook: p99 latency > 2000ms for 5 minutes

**Alert:** `histogram_quantile(0.99, sum(rate(cloudmesh_request_duration_ms_bucket[5m])) by (le)) > 2000` for 5m → pages on-call.

**Dashboard:** [CloudMesh — Overview](../docker/grafana/dashboards/overview.json) (`cloudmesh-overview`), latency panel.

## First checks, in order

1. **Is one provider slow?** Open [CloudMesh — Provider](../docker/grafana/dashboards/provider.json)
   (`cloudmesh-provider`) and check "Avg latency by model." If one model/provider
   is elevated and the others aren't, this is a provider-side issue, not a
   CloudMesh regression.
   - Check `cloudmesh_circuit_breaker_state{provider=...}` on the same
     dashboard — if it's climbing toward `open` (2), the circuit breaker
     (`packages/circuit-breaker`) should already be handling this by
     failing fast and, for `model:"auto"` requests, falling back to another
     configured provider (`apps/gateway/src/lib/resolveModel.ts`). Confirm
     it's actually happening; don't hand-intervene by force-opening the
     circuit ahead of it unless it's clearly not tripping when it should
     (`packages/circuit-breaker`'s `forceOpenCircuit` exists for exactly
     that — see its own doc comment for when manual intervention is
     legitimate).
2. **Did the semantic cache hit rate drop?** Check
   [CloudMesh — Cache](../docker/grafana/dashboards/cache.json) (`cloudmesh-cache`).
   A degraded or flushed cache pushes more traffic through to real LLM
   calls, which are inherently much slower than a cache hit — this alone
   can move p99 without anything actually being "broken."
3. **Is this a capacity ceiling, not a bug?** If this deployment runs under
   a Kubernetes HPA, check whether pods are still scaling up or are already
   pinned at `maxReplicas`. If pinned, bump the limit — this is a capacity
   ceiling, not a regression, and no code change will fix it.
4. **Check upstream provider status pages** (OpenAI, Anthropic, Google,
   or whatever's configured via `apps/gateway/src/env.ts`'s
   `*_BASE_URL`s) before assuming this is a CloudMesh-side regression. This
   codebase has no live provider credentials in any test/CI environment
   (see CLAUDE.md's Phase 3 notes) — a real upstream slowdown is a
   genuinely common cause this alert will catch that internal testing
   never could.

## Why this exists

An alert with no first step just means the on-call engineer starts
debugging from zero at 2am instead of from a known checklist. This is that
checklist — not exhaustive, but enough to rule out the common causes before
escalating.
