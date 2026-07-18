import { apiKeyCacheKey, generateApiKey, hashApiKey } from "@cloudmesh/auth";
import { Prisma, withTenant, type PrismaClient } from "@cloudmesh/db";
import type { Redis } from "ioredis";
import { NotFoundError } from "../../errors.js";

export interface ApiKeyDeps {
  db: PrismaClient;
  redis: Redis;
}

export interface CreatedApiKey {
  id: string;
  rawKey: string;
  keyPrefix: string;
  scopes: string[];
  rateLimitRpm: number;
}

export async function createApiKey(
  { db }: ApiKeyDeps,
  orgId: string,
  input: { scopes: string[]; rateLimitRpm?: number },
): Promise<CreatedApiKey> {
  const { rawKey, keyPrefix } = generateApiKey();
  const keyHash = hashApiKey(rawKey);

  const created = await withTenant(db, orgId, (tx) =>
    tx.apiKey.create({
      data: {
        orgId,
        keyHash,
        keyPrefix,
        scopes: input.scopes,
        rateLimitRpm: input.rateLimitRpm ?? 60,
      },
    }),
  );

  // rawKey is returned exactly once, here — it is never retrievable again,
  // since only its hash is persisted.
  return {
    id: created.id,
    rawKey,
    keyPrefix: created.keyPrefix,
    scopes: created.scopes,
    rateLimitRpm: created.rateLimitRpm,
  };
}

export interface ApiKeySummary {
  id: string;
  keyPrefix: string;
  scopes: string[];
  isActive: boolean;
  rateLimitRpm: number;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export async function listApiKeys({ db }: ApiKeyDeps, orgId: string): Promise<ApiKeySummary[]> {
  // RLS already scopes this to orgId; the explicit `where` is defense in
  // depth, not the only thing standing between this query and other
  // tenants' rows.
  return withTenant(db, orgId, (tx) =>
    tx.apiKey.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        keyPrefix: true,
        scopes: true,
        isActive: true,
        rateLimitRpm: true,
        lastUsedAt: true,
        createdAt: true,
      },
    }),
  );
}

export async function revokeApiKey(
  { db, redis }: ApiKeyDeps,
  orgId: string,
  keyId: string,
): Promise<void> {
  let revoked;
  try {
    // `where: { id: keyId }` alone is enough: RLS (via withTenant's
    // app.current_org) makes rows from other orgs invisible to this
    // transaction, so a cross-tenant id matches zero rows and Prisma
    // throws P2025 — the tenant boundary is enforced by Postgres here,
    // not by an orgId filter in this query.
    revoked = await withTenant(db, orgId, (tx) =>
      tx.apiKey.update({
        where: { id: keyId },
        data: { isActive: false },
      }),
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      // Same response whether the key belongs to another org or doesn't
      // exist at all — don't let this endpoint confirm another tenant's
      // key IDs.
      throw new NotFoundError("API key not found");
    }
    throw err;
  }

  // A revoked key must stop working immediately, not after the Redis
  // cache TTL expires — delete the cache entry in the same operation.
  await redis.del(apiKeyCacheKey(revoked.keyHash));
}
