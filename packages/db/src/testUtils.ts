import { getAdminPrisma } from "./client.js";

/**
 * Truncates every application table. Test-only — uses the admin (RLS-
 * bypassing) connection on purpose, since a test role restricted by RLS
 * couldn't clean up rows across tenants anyway. Never call this outside a
 * test setup/teardown hook.
 */
export async function resetDatabase(): Promise<void> {
  const prisma = getAdminPrisma();
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "usage_records", "semantic_cache", "api_keys", "users", "organizations" RESTART IDENTITY CASCADE;`,
  );
}
