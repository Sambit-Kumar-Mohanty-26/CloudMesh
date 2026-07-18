import { withTenant, type PrismaClient } from "@cloudmesh/db";
import type { Redis } from "ioredis";
import { apiKeyCacheKey, hashApiKey } from "./apiKey.js";

const CACHE_TTL_SECONDS = 300; // 5 minutes, per the Phase 1/2 design doc

export interface ApiKeyContext {
  apiKeyId: string;
  orgId: string;
  scopes: string[];
  rateLimitRpm: number;
}

/**
 * extractToken -> hashKey -> redisLookup -> dbLookup -> attachContext, per
 * the Phase 1 design doc. Shared by every service that accepts API-key auth
 * (apps/api, apps/gateway) so the security-critical lookup logic exists in
 * exactly one place — duplicating it risks the copies drifting and one
 * getting a fix the other doesn't.
 *
 * Returns null for "no such key" / "key is revoked" — callers decide how to
 * surface that (401, in every case seen so far) since that's HTTP-framework
 * specific and this function isn't.
 */
export async function resolveApiKey(
  db: PrismaClient,
  redis: Redis,
  rawKey: string,
  onBackgroundError?: (err: unknown) => void,
): Promise<ApiKeyContext | null> {
  const keyHash = hashApiKey(rawKey);
  const cacheKey = apiKeyCacheKey(keyHash);

  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as ApiKeyContext;
  }

  // api_keys has RLS, and at this point the caller's org is unknown by
  // definition — that's what this lookup resolves. A plain Prisma query
  // through the RLS-bound app role would see zero rows here, so this goes
  // through the lookup_api_key_by_hash() SECURITY DEFINER function instead
  // (packages/db/prisma/migrations/20260716060000_api_key_lookup_fn).
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      org_id: string;
      scopes: string[];
      is_active: boolean;
      rate_limit_rpm: number;
    }>
  >`SELECT * FROM lookup_api_key_by_hash(${keyHash})`;
  const record = rows[0];

  if (!record || !record.is_active) {
    return null;
  }

  const entry: ApiKeyContext = {
    apiKeyId: record.id,
    orgId: record.org_id,
    scopes: record.scopes,
    rateLimitRpm: record.rate_limit_rpm,
  };
  await redis.set(cacheKey, JSON.stringify(entry), "EX", CACHE_TTL_SECONDS);

  // Now that the org is known, this can go through the normal RLS-bound
  // path. Fire-and-forget: a failed "last used" timestamp must never fail
  // the request it's timestamping.
  withTenant(db, entry.orgId, (tx) =>
    tx.apiKey.update({ where: { id: entry.apiKeyId }, data: { lastUsedAt: new Date() } }),
  ).catch((err: unknown) => onBackgroundError?.(err));

  return entry;
}
