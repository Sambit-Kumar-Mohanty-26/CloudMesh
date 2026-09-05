-- Ties a job back to the API key that submitted it.
--
-- Without this, job-driven provider calls could not be billed at all:
-- usage_records.api_key_id is NOT NULL, the worker runs minutes after the
-- submitting HTTP request has returned, and jobs carried no key of their own.
--
-- Nullable on purpose. Rows created before this migration have no key to
-- backfill from, and ON DELETE SET NULL keeps a job's history intact when
-- the key that submitted it is later deleted — job history outliving a
-- rotated key is correct; erasing it (CASCADE) would not be.
--
-- Hand-written rather than generated: `prisma migrate dev` proposes dropping
-- semantic_cache_embedding_idx on essentially every invocation (it cannot
-- see a raw-SQL ivfflat index on an Unsupported() column). See
-- packages/db/ER_DIAGRAM.md.
ALTER TABLE "jobs" ADD COLUMN "api_key_id" UUID;

ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_api_key_id_fkey"
  FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
