import type { Prisma, PrismaClient } from "@prisma/client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` inside a transaction with `app.current_org` set for that
 * transaction only (`set_config(..., true)` — the Postgres equivalent of
 * `SET LOCAL`, parameterized so it's not string-built SQL), so every RLS
 * policy on api_keys/usage_records/semantic_cache scopes to this org.
 *
 * This is the only sanctioned way to touch those tables for a specific
 * tenant. Must be called with a client from `getAppPrisma()` — calling it
 * with the admin client is pointless, since the admin role bypasses RLS.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  orgId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(orgId)) {
    // Fails fast on garbage input rather than letting Postgres reject a
    // malformed ::uuid cast deep inside the transaction.
    throw new Error(`withTenant: orgId is not a valid UUID: ${orgId}`);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org', ${orgId}, true)`;
    return fn(tx);
  });
}
