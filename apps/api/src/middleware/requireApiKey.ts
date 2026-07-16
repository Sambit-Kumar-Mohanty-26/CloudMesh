import { withTenant } from "@cloudmesh/db";
import type { FastifyRequest } from "fastify";
import { hashApiKey } from "../lib/apiKey.js";
import { UnauthorizedError } from "../errors.js";

const CACHE_TTL_SECONDS = 300; // 5 minutes, per the Phase 1/2 design doc

export function apiKeyCacheKey(keyHash: string): string {
  return `auth:${keyHash}`;
}

export interface ApiKeyContext {
  apiKeyId: string;
  orgId: string;
  scopes: string[];
  rateLimitRpm: number;
}

declare module "fastify" {
  interface FastifyRequest {
    apiKeyCtx?: ApiKeyContext;
  }
}

interface CachedEntry {
  apiKeyId: string;
  orgId: string;
  scopes: string[];
  rateLimitRpm: number;
}

function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * extractToken -> hashKey -> redisLookup -> dbLookup -> attachContext, per
 * the Phase 1 design doc. A cache hit costs one Redis round trip; a miss
 * falls back to Postgres and repopulates the cache. Revoking a key deletes
 * this cache entry directly (see apiKeys/service.ts) rather than waiting
 * out the TTL, so a revoked key stops working on its very next request.
 */
export async function requireApiKey(request: FastifyRequest): Promise<void> {
  const rawKey = extractToken(request);
  if (!rawKey) {
    throw new UnauthorizedError("Missing or malformed Authorization header");
  }

  const keyHash = hashApiKey(rawKey);
  const cacheKey = apiKeyCacheKey(keyHash);

  const cached = await request.server.redis.get(cacheKey);
  if (cached) {
    const entry = JSON.parse(cached) as CachedEntry;
    request.apiKeyCtx = entry;
    return;
  }

  // api_keys has RLS, and at this point the caller's org is unknown by
  // definition — that's what this lookup resolves. A plain Prisma query
  // through the RLS-bound app role would see zero rows here, so this goes
  // through the lookup_api_key_by_hash() SECURITY DEFINER function instead
  // (packages/db/prisma/migrations/20260716060000_api_key_lookup_fn).
  const rows = await request.server.db.$queryRaw<
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
    throw new UnauthorizedError("Invalid API key");
  }

  const entry: CachedEntry = {
    apiKeyId: record.id,
    orgId: record.org_id,
    scopes: record.scopes,
    rateLimitRpm: record.rate_limit_rpm,
  };
  await request.server.redis.set(cacheKey, JSON.stringify(entry), "EX", CACHE_TTL_SECONDS);

  // Now that the org is known, this can go through the normal RLS-bound
  // path. Fire-and-forget: a failed "last used" timestamp must never fail
  // the request it's timestamping.
  withTenant(request.server.db, entry.orgId, (tx) =>
    tx.apiKey.update({ where: { id: entry.apiKeyId }, data: { lastUsedAt: new Date() } }),
  ).catch((err: unknown) => request.log.warn({ err }, "failed to update api key lastUsedAt"));

  request.apiKeyCtx = entry;
}
