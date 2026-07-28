import {
  deleteWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  registerWebhookEndpoint,
  UnsafeWebhookUrlError,
} from "@cloudmesh/webhooks";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { NotFoundError, ValidationError } from "../../errors.js";
import { requireJwt } from "../../middleware/requireJwt.js";
import { registerWebhookSchema } from "./schemas.js";

// Registration mints a new standing delivery target (its own secret) — the
// same "leaked JWT shouldn't mint unbounded standing things" risk category
// as apiKeys/routes.ts's create limit.
const registerRateLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
const deleteRateLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
const readRateLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

export default async function webhookRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", requireJwt);

  fastify.post("/webhooks", registerRateLimit, async (request, reply) => {
    let input;
    try {
      input = registerWebhookSchema.parse(request.body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError(err.issues[0]?.message ?? "Invalid request");
      }
      throw err;
    }

    const orgId = request.user!.orgId;
    try {
      const endpoint = await registerWebhookEndpoint(fastify.db, {
        orgId,
        url: input.url,
        eventTypes: input.eventTypes,
      });
      reply.code(201);
      return endpoint;
    } catch (err) {
      // The design doc's "checked at registration time — reject with 400
      // immediately": an unsafe target is the caller's mistake, not a
      // server error, so it maps to ValidationError, not a 500.
      if (err instanceof UnsafeWebhookUrlError) {
        throw new ValidationError(err.message);
      }
      throw err;
    }
  });

  fastify.get("/webhooks", readRateLimit, async (request) => {
    const orgId = request.user!.orgId;
    return listWebhookEndpoints(fastify.db, orgId);
  });

  fastify.delete("/webhooks/:id", deleteRateLimit, async (request, reply) => {
    const { id } = request.params as { id: string };
    const orgId = request.user!.orgId;
    const deleted = await deleteWebhookEndpoint(fastify.db, orgId, id);
    if (!deleted) throw new NotFoundError("Webhook endpoint not found");
    reply.code(204);
  });

  fastify.get("/webhooks/:id/deliveries", readRateLimit, async (request) => {
    const { id } = request.params as { id: string };
    const orgId = request.user!.orgId;
    const { limit } = request.query as { limit?: string };
    return listWebhookDeliveries(fastify.db, orgId, id, limit ? Number(limit) : undefined);
  });
}
