import { generateApiKey, hashApiKey } from "@cloudmesh/auth";
import { getAdminPrisma, resetDatabase } from "@cloudmesh/db";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";

export async function createTestApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

export async function resetAll(app: FastifyInstance): Promise<void> {
  await resetDatabase();
  await app.redis.flushdb();
}

/** Seeds an org + active API key directly via Prisma — apps/gateway has no
 *  /auth/register of its own (that's apps/api), so tests need a shortcut
 *  to a valid, authenticated org rather than going through HTTP. */
export async function createTestApiKey(
  orgName = "Gateway Test Org",
): Promise<{ rawKey: string; orgId: string }> {
  const db = getAdminPrisma();
  const org = await db.organization.create({ data: { name: orgName } });
  const { rawKey } = generateApiKey();
  await db.apiKey.create({
    data: {
      orgId: org.id,
      keyHash: hashApiKey(rawKey),
      keyPrefix: rawKey.slice(0, 12),
      scopes: ["chat:read", "chat:write"],
      rateLimitRpm: 60,
    },
  });
  return { rawKey, orgId: org.id };
}
