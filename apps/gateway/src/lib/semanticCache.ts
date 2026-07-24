import { createHash } from "node:crypto";
import { withTenant, type PrismaClient } from "@cloudmesh/db";
import type { Redis } from "ioredis";
import type { UnifiedMessage } from "../providers/types.js";

export interface SemanticCacheLookupOptions {
  similarityThreshold: number;
  ttlDays: number;
}

/**
 * Fingerprints the exact request (model + full message list), not just the
 * latest message — two requests with different system prompts or history
 * must not collide. Used both as a fast exact-match cache key (skips the
 * embedding call and pgvector search entirely on a literal repeat) and as
 * the request-dedup coalescing key (see lib/requestDedup.ts) — a repeat
 * counts as "the same request" for both purposes under the same definition.
 */
export function computePromptHash(model: string, messages: UnifiedMessage[]): string {
  const canonical = JSON.stringify({ model, messages });
  return createHash("sha256").update(canonical).digest("hex");
}

// pgvector's text input format is a plain bracketed list, e.g. "[0.1,-0.2]".
// Built from a validated number[] (never raw user input), then passed as a
// single bound parameter — Postgres does the text->vector cast via ::vector
// in the query itself, so this never becomes string-built SQL.
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Exact-hash hit first (cheap, no embedding compute needed by the caller for
 * this path — though the caller still had to embed for the fallback), then
 * cosine similarity via pgvector, both scoped by org_id AND model ("org_id
 * is a WHERE clause, not a suggestion" — see notes/cloudmesh.html's Phase 6
 * design). RLS is the backstop; the explicit org_id predicate here is also
 * what lets the query planner actually use the (org_id, model) index instead
 * of relying solely on the invisible RLS policy predicate.
 */
export async function lookupCache(
  db: PrismaClient,
  orgId: string,
  model: string,
  promptHash: string,
  embedding: number[],
  opts: SemanticCacheLookupOptions,
): Promise<string | null> {
  return withTenant(db, orgId, async (tx) => {
    const exact = await tx.$queryRaw<Array<{ response: string }>>`
      SELECT response FROM semantic_cache
      WHERE org_id = ${orgId}::uuid AND model = ${model} AND prompt_hash = ${promptHash}
        AND created_at > now() - make_interval(days => ${opts.ttlDays}::int)
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (exact[0]) return exact[0].response;

    const vectorLiteral = toVectorLiteral(embedding);
    const semantic = await tx.$queryRaw<Array<{ response: string; similarity: number }>>`
      SELECT response, 1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM semantic_cache
      WHERE org_id = ${orgId}::uuid AND model = ${model}
        AND embedding IS NOT NULL
        AND created_at > now() - make_interval(days => ${opts.ttlDays}::int)
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT 1
    `;
    const top = semantic[0];
    return top && top.similarity >= opts.similarityThreshold ? top.response : null;
  });
}

export async function storeCache(
  db: PrismaClient,
  orgId: string,
  model: string,
  promptHash: string,
  embedding: number[],
  response: string,
): Promise<void> {
  const vectorLiteral = toVectorLiteral(embedding);
  await withTenant(
    db,
    orgId,
    (tx) => tx.$executeRaw`
      INSERT INTO semantic_cache (id, org_id, model, prompt_hash, embedding, response)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${model}, ${promptHash}, ${vectorLiteral}::vector, ${response})
    `,
  );
}

/**
 * Explicit invalidation. With no `keepModel`, clears every cached entry for
 * the org. With `keepModel`, clears everything EXCEPT that model's entries —
 * the "partial" variant from the design doc, for retiring stale cache after
 * an org's default model changes without throwing away the still-current
 * model's cache too.
 */
export async function flushCache(
  db: PrismaClient,
  orgId: string,
  keepModel?: string,
): Promise<number> {
  return withTenant(db, orgId, async (tx) => {
    const result = keepModel
      ? await tx.$executeRaw`DELETE FROM semantic_cache WHERE org_id = ${orgId}::uuid AND model != ${keepModel}`
      : await tx.$executeRaw`DELETE FROM semantic_cache WHERE org_id = ${orgId}::uuid`;
    return result;
  });
}

function statsKey(orgId: string, outcome: "hit" | "miss"): string {
  return `cache_stats:${orgId}:${outcome}`;
}

export async function recordCacheOutcome(
  redis: Redis,
  orgId: string,
  outcome: "hit" | "miss",
): Promise<void> {
  await redis.incr(statsKey(orgId, outcome));
}

export interface CacheStats {
  hits: number;
  misses: number;
}

export async function getCacheStats(redis: Redis, orgId: string): Promise<CacheStats> {
  const [hits, misses] = await redis.mget(statsKey(orgId, "hit"), statsKey(orgId, "miss"));
  return { hits: Number(hits ?? 0), misses: Number(misses ?? 0) };
}
