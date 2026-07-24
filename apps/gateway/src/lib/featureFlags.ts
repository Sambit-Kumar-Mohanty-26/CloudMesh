import type { PrismaClient } from "@cloudmesh/db";
import type { Redis } from "ioredis";

const CACHE_TTL_SECONDS = 60; // per Phase 1's ER_DIAGRAM.md design note

// Shape set by packages/db/prisma/seed.ts and intended (Phase 1) as the
// per-org toggle surface for exactly these features. Unknown/missing keys
// default to "off" — a flag an org never set must never silently enable a
// feature for them.
export interface OrgFeatureFlags {
  semantic_cache: boolean;
  request_dedup: boolean;
  cache_ttl_days?: number;
}

const DEFAULTS: OrgFeatureFlags = { semantic_cache: false, request_dedup: false };

function cacheKey(orgId: string): string {
  return `feature_flags:${orgId}`;
}

function coerce(raw: unknown): OrgFeatureFlags {
  if (typeof raw !== "object" || raw === null) return DEFAULTS;
  const obj = raw as Record<string, unknown>;
  return {
    semantic_cache: obj.semantic_cache === true,
    request_dedup: obj.request_dedup === true,
    cache_ttl_days:
      typeof obj.cache_ttl_days === "number" && obj.cache_ttl_days > 0
        ? obj.cache_ttl_days
        : undefined,
  };
}

/**
 * `organizations` has no RLS (see CLAUDE.md) — reading feature_flags for a
 * known orgId is a plain, ordinary query, not something that needs
 * withTenant. Redis-cached per Phase 1's own design note ("intended to be
 * cached in Redis per org, TTL 60s, once the API layer exists").
 */
export async function getOrgFeatureFlags(
  db: PrismaClient,
  redis: Redis,
  orgId: string,
): Promise<OrgFeatureFlags> {
  const cached = await redis.get(cacheKey(orgId));
  if (cached) {
    return JSON.parse(cached) as OrgFeatureFlags;
  }

  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { featureFlags: true },
  });
  const flags = coerce(org?.featureFlags);
  await redis.set(cacheKey(orgId), JSON.stringify(flags), "EX", CACHE_TTL_SECONDS);
  return flags;
}
