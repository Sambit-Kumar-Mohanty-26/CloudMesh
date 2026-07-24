import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { ValidationError } from "../../errors.js";
import { requireJwt } from "../../middleware/requireJwt.js";
import { createApiKey, listApiKeys, revokeApiKey } from "./service.js";
import { createApiKeySchema } from "./schemas.js";

// Key creation mints a new standing credential - the same category of
// risk as login/register (see auth/routes.ts), just via a JWT session
// instead of a password. Tighter than the generic global baseline in
// app.ts, so a compromised/leaked JWT can't be used to mint an unbounded
// number of independent, longer-lived API keys before it's caught.
const createKeyRateLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

// Revocation is a mutation too — a leaked JWT shouldn't be able to mass-
// revoke every key an org has (a self-inflicted DoS on the org's own API
// access) faster than someone notices. Same limit as creation: same abuse
// shape, same category of risk.
const revokeKeyRateLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

// Listing is read-only and lower-risk than mint/revoke, but still gets its
// own explicit limit rather than relying solely on the generic global
// baseline in app.ts — this router handles nothing but credential
// management, so every route in it gets rate limiting called out
// explicitly instead of leaving one to an implicit, easy-to-miss default.
const listKeysRateLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

export default async function apiKeyRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", requireJwt);

  fastify.post("/api-keys", createKeyRateLimit, async (request, reply) => {
    let input;
    try {
      input = createApiKeySchema.parse(request.body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError(err.issues[0]?.message ?? "Invalid request");
      }
      throw err;
    }

    // request.user is guaranteed by the requireJwt preHandler above.
    const orgId = request.user!.orgId;
    const key = await createApiKey({ db: fastify.db, redis: fastify.redis }, orgId, input);
    reply.code(201);
    return key;
  });

  fastify.get("/api-keys", listKeysRateLimit, async (request) => {
    const orgId = request.user!.orgId;
    return listApiKeys({ db: fastify.db, redis: fastify.redis }, orgId);
  });

  fastify.delete("/api-keys/:id", revokeKeyRateLimit, async (request, reply) => {
    const { id } = request.params as { id: string };
    const orgId = request.user!.orgId;
    await revokeApiKey({ db: fastify.db, redis: fastify.redis }, orgId, id);
    reply.code(204);
  });
}
