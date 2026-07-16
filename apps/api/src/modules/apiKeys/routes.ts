import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { ValidationError } from "../../errors.js";
import { requireJwt } from "../../middleware/requireJwt.js";
import { createApiKey, listApiKeys, revokeApiKey } from "./service.js";
import { createApiKeySchema } from "./schemas.js";

export default async function apiKeyRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", requireJwt);

  fastify.post("/api-keys", async (request, reply) => {
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

  fastify.get("/api-keys", async (request) => {
    const orgId = request.user!.orgId;
    return listApiKeys({ db: fastify.db, redis: fastify.redis }, orgId);
  });

  fastify.delete("/api-keys/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const orgId = request.user!.orgId;
    await revokeApiKey({ db: fastify.db, redis: fastify.redis }, orgId, id);
    reply.code(204);
  });
}
