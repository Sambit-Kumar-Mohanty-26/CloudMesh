import { buildOpenApiDocument, swaggerUiHtml } from "@cloudmesh/openapi";
import type { FastifyInstance } from "fastify";
import { env } from "../../env.js";
import { chatRequestSchema } from "../chat/schemas.js";
import { createJobSchema, listJobsQuerySchema } from "../jobs/schemas.js";

/**
 * Public API reference: the OpenAPI document at `/openapi.json` and Swagger
 * UI at `/docs`.
 *
 * Both are deliberately UNAUTHENTICATED, unlike every other `/v1` route.
 * The document describes the shape of the API — the same information any
 * published SDK or documentation site contains — and contains no tenant
 * data, no keys and no org-scoped values. Requiring an API key to read the
 * docs would mean a developer needs credentials before they can find out
 * how to use credentials.
 *
 * These are also outside the `/v1` prefix on purpose: the reference
 * describes every version the deployment serves, so versioning the
 * reference itself alongside the API it documents would be circular.
 *
 * The document is built once at registration, not per request — the Zod
 * schemas it derives from are static module-level values, so rebuilding it
 * on every hit would be pure waste.
 */
export default async function docsRoutes(fastify: FastifyInstance) {
  const document = buildOpenApiDocument(
    {
      chatRequest: chatRequestSchema,
      createJob: createJobSchema,
      listJobsQuery: listJobsQuerySchema,
    },
    { serverUrl: env.PUBLIC_BASE_URL },
  );

  const html = swaggerUiHtml("/openapi.json");

  fastify.get("/openapi.json", async () => document);

  fastify.get("/docs", async (_request, reply) => {
    // text/html, not Fastify's default application/json — without this the
    // browser downloads the page instead of rendering it.
    reply.type("text/html; charset=utf-8");
    return html;
  });
}
