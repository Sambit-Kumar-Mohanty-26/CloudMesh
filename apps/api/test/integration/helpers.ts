import { resetDatabase } from "@cloudmesh/db";
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

export function extractSetCookie(
  rawHeader: string | string[] | undefined,
  name: string,
): string | undefined {
  const headers = Array.isArray(rawHeader) ? rawHeader : rawHeader ? [rawHeader] : [];
  for (const h of headers) {
    if (h.startsWith(`${name}=`)) {
      return h.split(";")[0]?.split("=")[1];
    }
  }
  return undefined;
}
