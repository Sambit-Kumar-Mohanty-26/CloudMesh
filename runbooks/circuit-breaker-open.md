# Runbook: circuit_breaker_state == open for > 5 minutes

**Alert:** `cloudmesh_circuit_breaker_state == 2` for 5m → pages on-call.
(`0 = closed`, `1 = half_open`, `2 = open` — see
`packages/metrics/src/metrics.ts`'s `setCircuitBreakerState`.)

**Dashboard:** [CloudMesh — Provider](../docker/grafana/dashboards/provider.json)
(`cloudmesh-provider`), circuit breaker state panel — the `provider` label
on the alert tells you which one tripped.

## First checks, in order

1. **Confirm it's a real provider outage, not a config error.** Check the
   affected provider's own status page, and check whether this deployment's
   config for that provider changed recently (`apps/gateway/.env`'s
   `*_API_KEY`/`*_BASE_URL` for the tripped provider, or a recent deploy).
   A misconfigured base URL or an expired/rotated key produces the exact
   same symptom as a real outage — every call fails, the breaker trips —
   but the fix is completely different (a config rollback, not "wait it
   out").
2. **If it's a real outage:** no action needed for the breaker itself —
   traffic is already failing over. `model:"auto"` requests are already
   being routed around the open circuit (`lib/resolveModel.ts`'s
   `resolveModelWithFallback`, which skips any candidate whose circuit is
   open); an **explicit** model request to the down provider is not
   silently swapped and will keep returning 503 by design (see CLAUDE.md's
   Phase 5 notes — this is intentional, not a gap). Verify the fallback
   provider's own error rate/latency ([CloudMesh — Overview](../docker/grafana/dashboards/overview.json))
   is still normal — a fallback absorbing 100% of traffic can itself get
   overloaded.
3. **If every configured provider's circuit is open** (`model:"auto"`
   requests are returning `503 ALL_PROVIDERS_UNAVAILABLE` — see
   `apps/gateway/src/errors.ts`'s `AllProvidersUnavailableError`), this is
   a genuine full outage of this gateway's chat capability, not a
   single-provider degradation. Escalate immediately rather than waiting
   out this runbook's later steps.
4. **If it's been open for more than 15 minutes:** page the provider's own
   support/status channel. At this point it's an SLA conversation with the
   upstream vendor, not something further CloudMesh-side debugging will
   resolve.
5. **Do not manually force-close the circuit** (`packages/circuit-breaker`'s
   `resetCircuit`) unless you've independently confirmed via step 1 that
   the underlying cause is actually fixed. The breaker's own half-open
   probe (one request, atomically claimed — see CLAUDE.md's Phase 5 notes
   on why this is Redis+Lua, not just app-code discipline) already tests
   recovery safely on its own schedule; force-closing before the real fix
   just re-trips it on the very next failing request.

## Why this exists

Same reasoning as the other two runbooks: a page with no first step means
debugging starts from zero. Distinguishing "real outage, already
handled" from "config error, needs a human fix" is the one judgment call
this alert can't make for you — everything else here is closed procedure.
