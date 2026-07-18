import { resolveApiKey, type ApiKeyContext } from "@cloudmesh/auth";
import type { FastifyRequest } from "fastify";
import { UnauthorizedError } from "../errors.js";

declare module "fastify" {
  interface FastifyRequest {
    apiKeyCtx?: ApiKeyContext;
  }
}

function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Identical chain to apps/api's requireApiKey — both are thin Fastify glue
 * around the shared resolveApiKey() in @cloudmesh/auth.
 */
export async function requireApiKey(request: FastifyRequest): Promise<void> {
  const rawKey = extractToken(request);
  if (!rawKey) {
    throw new UnauthorizedError("Missing or malformed Authorization header");
  }

  const ctx = await resolveApiKey(request.server.db, request.server.redis, rawKey, (err) =>
    request.log.warn({ err }, "failed to update api key lastUsedAt"),
  );

  if (!ctx) {
    throw new UnauthorizedError("Invalid API key");
  }

  request.apiKeyCtx = ctx;
}
