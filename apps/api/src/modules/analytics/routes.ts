import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { ValidationError } from "../../errors.js";
import { requireJwt } from "../../middleware/requireJwt.js";
import { getAnalytics, listRequestLogs } from "./service.js";
import { logsQuerySchema, periodSchema } from "./schemas.js";

// Read-only, but still worth its own explicit limit — same "every route in
// a router gets one stated, not an implicit inherited default" convention
// as billing/apiKeys/webhooks routes.ts.
const analyticsReadRateLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

export default async function analyticsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", requireJwt);

  fastify.get("/analytics", analyticsReadRateLimit, async (request) => {
    const query = request.query as { period?: string };
    let period;
    try {
      period = periodSchema.parse(query.period);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError(err.issues[0]?.message ?? "Invalid period");
      }
      throw err;
    }
    const orgId = request.user!.orgId;
    return getAnalytics(fastify.db, orgId, period);
  });

  fastify.get("/analytics/logs", analyticsReadRateLimit, async (request) => {
    let filters;
    try {
      filters = logsQuerySchema.parse(request.query);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError(err.issues[0]?.message ?? "Invalid request");
      }
      throw err;
    }
    const orgId = request.user!.orgId;
    return listRequestLogs(fastify.db, orgId, filters);
  });
}
