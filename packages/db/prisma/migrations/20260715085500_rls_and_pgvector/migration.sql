-- pgvector extension + embedding column for semantic cache
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "semantic_cache" ADD COLUMN "embedding" vector(1536);

CREATE INDEX "semantic_cache_embedding_idx" ON "semantic_cache"
  USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

-- Row-Level Security: tenant isolation enforced by the database, not app code.
-- FORCE ROW LEVEL SECURITY so even the owning role is bound by the policy.
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;

ALTER TABLE "usage_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_records" FORCE ROW LEVEL SECURITY;

ALTER TABLE "semantic_cache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "semantic_cache" FORCE ROW LEVEL SECURITY;

-- current_setting(..., true) returns NULL instead of erroring when
-- app.current_org hasn't been SET for the session — NULL comparisons are
-- false, so a request that forgets to set it is denied, not leaked.
CREATE POLICY "tenant_isolation" ON "api_keys"
  USING ("org_id" = current_setting('app.current_org', true)::uuid);

CREATE POLICY "tenant_isolation" ON "usage_records"
  USING ("org_id" = current_setting('app.current_org', true)::uuid);

CREATE POLICY "tenant_isolation" ON "semantic_cache"
  USING ("org_id" = current_setting('app.current_org', true)::uuid);
