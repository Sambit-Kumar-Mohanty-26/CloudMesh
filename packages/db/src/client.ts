import { PrismaClient } from "@prisma/client";

let adminClient: PrismaClient | undefined;
let appClient: PrismaClient | undefined;

/**
 * Connects as the Postgres bootstrap superuser (`DATABASE_URL`). Bypasses
 * Row-Level Security entirely — for migrations, seeding, and test fixtures
 * only. Never use this to serve an application request.
 */
export function getAdminPrisma(): PrismaClient {
  if (!adminClient) {
    const url = requireEnv("DATABASE_URL");
    adminClient = new PrismaClient({ datasourceUrl: url });
  }
  return adminClient;
}

/**
 * Connects as the non-superuser `cloudmesh_app` role (`APP_DATABASE_URL`).
 * This is RLS-bound and is the only client application services should use.
 */
export function getAppPrisma(): PrismaClient {
  if (!appClient) {
    const url = requireEnv("APP_DATABASE_URL");
    appClient = new PrismaClient({ datasourceUrl: url });
  }
  return appClient;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Refusing to silently fall back to another ` +
        `connection — the admin and app connections have different RLS ` +
        `guarantees and must not be confused.`,
    );
  }
  return value;
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([adminClient?.$disconnect(), appClient?.$disconnect()]);
}
