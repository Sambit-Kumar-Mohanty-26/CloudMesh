/*
  Warnings:

  - Added the required column `model` to the `semantic_cache` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
--
-- Prisma's migration diff doesn't understand the `Unsupported("vector(1536)")`
-- column or the ivfflat index created on it via raw SQL in
-- 20260715085500_rls_and_pgvector — it sees an index it can't account for in
-- schema.prisma and drops it. Recreated below immediately after, so this
-- migration is a no-op for the vector index rather than a silent regression.
DROP INDEX "semantic_cache_embedding_idx";

-- DropIndex
DROP INDEX "semantic_cache_org_id_idx";

-- AlterTable
ALTER TABLE "semantic_cache" ADD COLUMN     "model" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "semantic_cache_org_id_model_idx" ON "semantic_cache"("org_id", "model");

-- CreateIndex (recreate the ivfflat cosine-similarity index Prisma's diff
-- above dropped without understanding it — see comment above)
CREATE INDEX "semantic_cache_embedding_idx" ON "semantic_cache"
  USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
