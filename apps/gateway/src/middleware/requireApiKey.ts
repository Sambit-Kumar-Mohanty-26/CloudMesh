import { resolveApiKey, type ApiKeyContext } from "@cloudmesh/auth";
import { withSpan } from "@cloudmesh/telemetry";
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
 * around the shared resolveApiKey() in @cloudmesh/auth. Wrapped in a named
 * span (Phase 12's "Auth middleware -> child span { latency, result }"
 * from the design doc's tracing diagram) — this preHandler runs inside the
 * HTTP auto-instrumentation's root span for the request, so it nests
 * correctly with zero extra wiring.
 */
export async function requireApiKey(request: FastifyRequest): Promise<void> {
  return withSpan("auth", {}, async (span) => {
    const rawKey = extractToken(request);
    if (!rawKey) {
      span.setAttribute("result", "missing_token");
      throw new UnauthorizedError("Missing or malformed Authorization header");
    }

    const ctx = await resolveApiKey(request.server.db, request.server.redis, rawKey, (err) =>
      request.log.warn({ err }, "failed to update api key lastUsedAt"),
    );

    if (!ctx) {
      span.setAttribute("result", "invalid_key");
      throw new UnauthorizedError("Invalid API key");
    }

    span.setAttribute("result", "ok");
    span.setAttribute("orgId", ctx.orgId);
    request.apiKeyCtx = ctx;
  });
}
