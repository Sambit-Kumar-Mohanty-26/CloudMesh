# Runbook: usage_records write failures > 0 (billing)

**Alert:** `increase(cloudmesh_usage_write_failures_total[5m]) > 0` → pages
**immediately**, on any occurrence — unlike the other two runbooks, this
does not wait for a sustained threshold.

**Why this one pages differently:** a silent billing write failure is a
revenue/trust issue, not a latency one. The chat response may still have
succeeded and been returned to the customer while the usage that should
have been billed for it was lost — every minute this goes unnoticed is
unbilled/unaccounted usage that (depending on retention) may not be
reconstructable after the fact.

**Where this is wired:** `apps/gateway/src/modules/chat/routes.ts`'s
`recordUsageOrCountFailure` wraps every call to
`lib/billing.ts`'s `recordUsageAndOutbox` (both the non-streaming and
streaming paths) — a genuine write failure increments this counter,
labeled by `org`, before re-throwing. The request still fails (a 500) in
this case; silently returning success while dropping the usage record
would be the worse outcome, not a mitigation.

## First checks, in order

1. **Check Postgres connection pool exhaustion first — the most common
   cause.** If `apps/gateway` (or any other service sharing the same
   Postgres instance) is running near its configured pool limit, new
   writes queue and eventually time out. Check active connection count
   against `packages/db`'s configured pool size.
2. **Check the outbox table for a backlog.** `recordUsageAndOutbox` writes
   the `usage_records` row and its `usage.recorded` outbox event in the
   same transaction (`packages/outbox`) — if `outbox_events` has a growing
   count of unpublished rows, the NATS consumer side is stuck or lagging,
   not the write path itself. That's a different, separate problem (see
   CLAUDE.md's Phase 10 notes on the outbox poller) from an actual INSERT
   failure, and this alert's `cloudmesh_usage_write_failures_total` will be
   flat (zero) in that case — a growing outbox backlog with THIS alert
   still quiet means the write succeeded fine, only publishing is delayed.
3. **Check for a schema/migration mismatch.** If a recent deploy shipped a
   Prisma migration that hasn't actually been applied to this environment
   yet (`npm run migrate:deploy --workspace=@cloudmesh/db`), every raw
   `INSERT INTO usage_records` in `recordUsageAndOutbox` fails identically,
   immediately, for every single request — a fast, complete outage of
   billing specifically, distinguishable from pool exhaustion (which
   degrades gradually, not instantly for 100% of traffic).
4. **Check RLS.** `usage_records` has `FORCE ROW LEVEL SECURITY` — if this
   deployment's `APP_DATABASE_URL` was ever pointed at the wrong role (the
   migration superuser instead of `cloudmesh_app`), or `app.current_org`
   isn't being set correctly for the transaction, writes can fail RLS
   checks. Confirm the gateway is connecting via `getAppPrisma()`, never
   `getAdminPrisma()`, for this path (see CLAUDE.md's cross-cutting notes).
5. **Read the actual Postgres error**, not just the fact that this counter
   incremented — `apps/gateway`'s structured logs (correlated by
   `trace_id`/`span_id` — see the Jaeger trace for the specific failed
   request, which the `llm_provider` and `billing` spans on the same trace
   will help narrow to server-side vs. request-input caused) carry the real
   exception. This runbook's first four steps are the common causes, not
   an exhaustive list.

## Why this exists

Same reasoning as the other two runbooks — a page with no first step means
2am debugging starts from zero. This one additionally pages on the FIRST
occurrence rather than a sustained rate, because the design doc treats any
billing write failure as a revenue-impacting event worth immediate
attention, not something to average over a window.
