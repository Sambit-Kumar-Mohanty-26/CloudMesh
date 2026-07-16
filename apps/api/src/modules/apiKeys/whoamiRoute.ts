import type { FastifyInstance } from "fastify";
import { requireApiKey } from "../../middleware/requireApiKey.js";

/**
 * Minimal route whose only purpose is giving requireApiKey something real
 * to protect — the actual gateway routes that consume API keys belong to
 * Phase 3. Without this, the auth middleware chain (extract -> hash ->
 * redis -> db -> attach) would ship with zero HTTP-level test coverage.
 */
export default async function whoamiRoute(fastify: FastifyInstance) {
  fastify.get("/v1/whoami", { preHandler: requireApiKey }, async (request) => {
    return request.apiKeyCtx;
  });
}
