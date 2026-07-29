import type { FastifyInstance } from "fastify";
import { registry } from "./registry.js";

/**
 * GET /metrics — the Prometheus scrape endpoint. Deliberately
 * unauthenticated: Prometheus can't easily present a JWT or API key on a
 * scrape, and every real deployment's convention for this route is a
 * network-policy boundary (only reachable from inside the scrape network),
 * not an application-layer one — this route can't enforce that itself, and
 * doesn't try to.
 */
export async function registerMetricsRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });
}
