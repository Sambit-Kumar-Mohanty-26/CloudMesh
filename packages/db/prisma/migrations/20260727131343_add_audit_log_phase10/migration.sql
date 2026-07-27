-- DropIndex
--
-- The recurring Prisma ivfflat gotcha (see ER_DIAGRAM.md): the diff engine
-- does not model the raw-SQL ivfflat index and proposes dropping it on
-- essentially every migrate command, including this one, which touches
-- nothing but a new audit_log table. Recreated at the bottom.
DROP INDEX "semantic_cache_embedding_idx";

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_event_id_key" ON "audit_log"("event_id");

-- CreateIndex
CREATE INDEX "audit_log_org_id_created_at_idx" ON "audit_log"("org_id", "created_at");

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security for audit_log — same tenant_isolation pattern as every
-- other tenant table. An audit entry's payload mirrors whatever the source
-- event carried (token counts, costs, model names), so cross-org reads
-- would leak exactly the operational data an audit trail exists to protect.
--
-- The audit SUBSCRIBER writes these while consuming events for every org
-- from one process, so it sets app.current_org per message, exactly like
-- the Phase 9 job worker does.
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "audit_log"
  USING ("org_id" = current_setting('app.current_org', true)::uuid);

-- CreateIndex (recreate the ivfflat index dropped above — see that comment)
CREATE INDEX "semantic_cache_embedding_idx" ON "semantic_cache"
  USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
