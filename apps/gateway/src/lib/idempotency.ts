import type { Redis } from "ioredis";

function idempotencyKey(orgId: string, key: string): string {
  // Namespaced by org — an idempotency key is only meaningful within the
  // tenant that sent it; two orgs coincidentally using the same literal
  // key string must never collide.
  return `idempotency:${orgId}:${key}`;
}

export interface IdempotentRecord {
  statusCode: number;
  body: unknown;
}

export async function getIdempotentReplay(
  redis: Redis,
  orgId: string,
  key: string,
): Promise<IdempotentRecord | null> {
  const cached = await redis.get(idempotencyKey(orgId, key));
  return cached ? (JSON.parse(cached) as IdempotentRecord) : null;
}

export async function storeIdempotentResult(
  redis: Redis,
  orgId: string,
  key: string,
  record: IdempotentRecord,
  ttlSeconds: number,
): Promise<void> {
  await redis.set(idempotencyKey(orgId, key), JSON.stringify(record), "EX", ttlSeconds);
}
