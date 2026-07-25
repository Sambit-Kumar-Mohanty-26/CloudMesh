-- Prisma's diff proposed a "DropIndex semantic_cache_embedding_idx" here
-- too — it treats the raw-SQL ivfflat index as drift on EVERY migrate
-- command, not just ones that touch semantic_cache (see ER_DIAGRAM.md and
-- 20260725024959_add_billing_phase7's comment). Removed entirely rather
-- than drop-then-recreate, since this migration has no real reason to
-- touch that index at all.

-- Row-Level Security for invoices — same tenant_isolation pattern as
-- api_keys/usage_records/semantic_cache (see 20260715085500_rls_and_pgvector).
-- billing_plans, stripe_events, and outbox_events deliberately have NO RLS
-- (see the comments on those models in schema.prisma): billing_plans is
-- global product config, not tenant data; stripe_events and outbox_events
-- are only ever read by internal system processes (webhook dedup, the
-- outbox poller), never by a tenant-scoped API request.
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "invoices"
  USING ("org_id" = current_setting('app.current_org', true)::uuid);
