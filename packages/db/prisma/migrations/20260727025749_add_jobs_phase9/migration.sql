-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD_LETTER');

-- DropIndex
--
-- Prisma's diff proposed this again, exactly as documented in
-- packages/db/ER_DIAGRAM.md and hit by every migration since Phase 6: it
-- doesn't model the raw-SQL ivfflat index on semantic_cache and treats it
-- as drift on essentially every `migrate dev`, even one like this that
-- touches nothing but a brand-new `jobs` table. Recreated at the bottom.
DROP INDEX "semantic_cache_embedding_idx";

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "bull_job_id" TEXT,
    "type" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 10,
    "payload" JSONB NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "jobs_org_id_created_at_idx" ON "jobs"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "jobs_org_id_status_idx" ON "jobs"("org_id", "status");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security for jobs — same tenant_isolation pattern as
-- api_keys/usage_records/semantic_cache/invoices (see
-- 20260715085500_rls_and_pgvector). A job's payload and result hold
-- arbitrary tenant data, so a cross-org read on GET /v1/jobs/:id would be a
-- direct data leak; enforcing it in Postgres means a mistake in the jobs
-- routes can't cause one.
--
-- The WORKER is why this needs care: it drains jobs across every org, so it
-- must set app.current_org per job (see packages/jobs) rather than running
-- unscoped. It connects as the same RLS-bound cloudmesh_app role as the
-- HTTP path, never as the migration superuser.
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "jobs"
  USING ("org_id" = current_setting('app.current_org', true)::uuid);

-- CreateIndex (recreate the ivfflat cosine-similarity index dropped above —
-- see the comment on that DROP INDEX statement)
CREATE INDEX "semantic_cache_embedding_idx" ON "semantic_cache"
  USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
