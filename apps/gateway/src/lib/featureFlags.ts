import type { PrismaClient } from "@cloudmesh/db";
import type { Redis } from "ioredis";
import {
  DEFAULT_ROUTING_PRESET,
  isRoutingPresetName,
  type RoutingPresetName,
} from "./routingScoring.js";

const CACHE_TTL_SECONDS = 60; // per Phase 1's ER_DIAGRAM.md design note

/** Weighted model-variant split for A/B routing (Phase 8), e.g.
 *  `{ "gpt-4o": 0.7, "gpt-4o-mini": 0.3 }`. Keys are model names, values
 *  are relative weights (not required to sum to 1 — normalized at
 *  selection time). A max of 10 entries and a max weight guard against a
 *  hostile/malformed config wedging routing in a pathological loop or
 *  allocating unboundedly. */
export type AbConfig = Record<string, number>;
const AB_CONFIG_MAX_VARIANTS = 10;
const AB_CONFIG_MAX_WEIGHT = 1_000_000;

// Shape set by packages/db/prisma/seed.ts and intended (Phase 1) as the
// per-org toggle surface for exactly these features. Unknown/missing keys
// default to "off" — a flag an org never set must never silently enable a
// feature for them.
export interface OrgFeatureFlags {
  semantic_cache: boolean;
  request_dedup: boolean;
  cache_ttl_days?: number;
  // Phase 7: hard budget enforcement (402 past the cap) + auto-model
  // downgrade near the cap. Off by default like every other flag here —
  // usage_records is still written for every org regardless of this flag
  // (that's plain observability, not enforcement), only the
  // reject/downgrade behavior is gated.
  billing_enforcement: boolean;
  // Phase 8: which named weight preset "auto" resolution scores candidates
  // with (see lib/routingScoring.ts) — always a valid preset name, never
  // hand-set weights; an unrecognized/missing value falls back to the
  // documented default (cost_optimized), never throws.
  routing_preset: RoutingPresetName;
  // Phase 8: optional weighted model-variant split for A/B testing "auto"
  // resolution — see routing.ts. Undefined (the default) means no A/B
  // split is active for this org; ordinary preset-scored routing applies.
  ab_config?: AbConfig;
}

const DEFAULTS: OrgFeatureFlags = {
  semantic_cache: false,
  request_dedup: false,
  billing_enforcement: false,
  routing_preset: DEFAULT_ROUTING_PRESET,
};

function coerceAbConfig(raw: unknown): AbConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === "number" &&
      Number.isFinite(entry[1]) &&
      entry[1] > 0 &&
      entry[1] <= AB_CONFIG_MAX_WEIGHT &&
      entry[0].length > 0,
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.slice(0, AB_CONFIG_MAX_VARIANTS));
}

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
    billing_enforcement: obj.billing_enforcement === true,
    routing_preset: isRoutingPresetName(obj.routing_preset)
      ? obj.routing_preset
      : DEFAULT_ROUTING_PRESET,
    ab_config: coerceAbConfig(obj.ab_config),
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
