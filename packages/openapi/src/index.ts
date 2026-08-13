import { z } from "zod";

/**
 * Builds CloudMesh's OpenAPI 3.1 document.
 *
 * The design doc describes this as "Fastify JSON schema -> swagger-ui", but
 * this codebase's routes do not use Fastify's `schema:` option — every
 * handler validates by calling its Zod schema's `.parse()` directly, and
 * the resulting `ValidationError` shape (and its exact messages) is
 * asserted by existing tests. Attaching JSON Schema to the routes purely to
 * document them would ALSO switch on Fastify's own validation, changing
 * those responses; maintaining a second, hand-written JSON Schema per route
 * would be a copy that silently drifts from the one that actually runs.
 *
 * So the spec is generated from the same Zod schemas the handlers validate
 * with, via Zod 4's native `z.toJSONSchema()`. Single source of truth, and
 * a request body documented here is by construction the one the server
 * enforces. The trade-off is that route *registration* isn't what produces
 * the spec, so a newly added route has to be listed here too — covered by
 * a test that asserts every documented path is one the gateway actually
 * serves.
 */

export interface OpenApiOptions {
  /** Public base URL of the deployment, e.g. https://api.example.com */
  serverUrl?: string;
  version?: string;
}

/** JSON Schema for a Zod schema, inlined (no $defs/$ref indirection, which
 *  Swagger UI renders poorly for small request bodies). */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  // OpenAPI 3.1 is a superset of JSON Schema 2020-12, so the dialect
  // declaration is redundant inside a component and Swagger UI shows it as
  // a stray field.
  delete out.$schema;
  return out;
}

const errorResponse = {
  type: "object",
  properties: {
    error: { type: "string", description: "Human-readable message." },
    code: {
      type: "string",
      description: "Stable machine-readable code — switch on this, not the message.",
    },
  },
  required: ["error", "code"],
} as const;

function jsonBody(schema: Record<string, unknown>) {
  return { content: { "application/json": { schema } } };
}

function errorsFor(...codes: string[]) {
  const descriptions: Record<string, string> = {
    "400": "Invalid request body or query parameters.",
    "401": "Missing, malformed, or revoked API key.",
    "402": "Organization budget exhausted (billing enforcement enabled).",
    "404": "No such resource, or it belongs to another organization.",
    "429": "Rate limit exceeded. Honour the Retry-After header.",
    "500": "Unexpected server error.",
    "502": "Upstream provider returned an error.",
    "503": "All candidate providers are unavailable (circuit breakers open).",
  };
  return Object.fromEntries(
    codes.map((c) => [c, { description: descriptions[c] ?? "Error", ...jsonBody(errorResponse) }]),
  );
}

/**
 * `schemas` is injected rather than imported so this package stays free of
 * a dependency on apps/gateway (which would be a cycle — the gateway serves
 * this document). Each app passes its own real, in-use Zod schemas in.
 */
export interface CloudMeshSchemas {
  chatRequest: z.ZodType;
  createJob: z.ZodType;
  listJobsQuery: z.ZodType;
}

export function buildOpenApiDocument(
  schemas: CloudMeshSchemas,
  options: OpenApiOptions = {},
): Record<string, unknown> {
  const { serverUrl = "http://localhost:3001", version = "1.0.0" } = options;

  return {
    openapi: "3.1.0",
    info: {
      title: "CloudMesh API",
      version,
      description:
        "Unified AI gateway: one API across OpenAI, Anthropic, Gemini and Ollama, with " +
        "per-key rate limiting, semantic caching, cost-aware routing, circuit breaking, " +
        "usage-based billing and async jobs.\n\n" +
        "Authenticate with an API key created in the dashboard: " +
        "`Authorization: Bearer cm_live_...`. The raw key is shown exactly once, at " +
        "creation — CloudMesh stores only a SHA-256 hash of it and cannot recover it.",
      license: { name: "MIT" },
    },
    servers: [{ url: serverUrl }],
    tags: [
      { name: "Chat", description: "Completions across every configured provider." },
      { name: "Models", description: "Live model discovery." },
      { name: "Jobs", description: "Asynchronous batch work." },
      { name: "Cache", description: "Semantic cache statistics and invalidation." },
      { name: "Routing", description: "Provider scoring and A/B routing telemetry." },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "An API key, sent as `Authorization: Bearer cm_live_...`. Revoking a key " +
            "takes effect immediately, not after a cache TTL.",
        },
      },
      schemas: {
        ChatRequest: jsonSchema(schemas.chatRequest),
        CreateJobRequest: jsonSchema(schemas.createJob),
        Error: errorResponse,
      },
    },
    security: [{ ApiKeyAuth: [] }],
    paths: {
      "/v1/chat": {
        post: {
          tags: ["Chat"],
          summary: "Create a chat completion",
          description:
            'Set `model: "auto"` to let the routing engine score every candidate on ' +
            "cost, latency and reliability. An explicit model is never silently " +
            "substituted — if its circuit is open you get a 503 rather than a " +
            "different model's answer.\n\n" +
            "With `stream: true` the response is `text/event-stream`: `data:` frames " +
            "each carrying a `delta` string (the increment, not the running total) " +
            "alongside `id`/`model`/`provider`/`done`, terminated by a literal " +
            "`data: [DONE]` frame.\n\n" +
            "Send an `Idempotency-Key` header to make retries safe; a replay returns " +
            "the original result as plain JSON even if the first call was streamed.",
          operationId: "createChatCompletion",
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              schema: { type: "string", maxLength: 255 },
              description: "Replay-safe key. Identical keys return the first result.",
            },
          ],
          requestBody: {
            required: true,
            ...jsonBody({ $ref: "#/components/schemas/ChatRequest" }),
          },
          responses: {
            "200": {
              description:
                "A completion. `text/event-stream` instead of JSON when `stream` is true.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      model: { type: "string", description: "The model that actually served it." },
                      provider: {
                        type: "string",
                        description: 'Which upstream served it, e.g. "openai", "anthropic".',
                      },
                      message: {
                        type: "object",
                        properties: {
                          role: { type: "string", enum: ["assistant"] },
                          content: { type: "string" },
                        },
                      },
                      finishReason: {
                        type: "string",
                        description: 'Why generation stopped, e.g. "stop" or "length".',
                      },
                      usage: {
                        type: "object",
                        description:
                          "Only the two components are sent; there is no `totalTokens` field. " +
                          "Both official SDKs expose a computed total as a convenience.",
                        properties: {
                          promptTokens: { type: "integer" },
                          completionTokens: { type: "integer" },
                        },
                      },
                      cached: {
                        type: "boolean",
                        description: "True when served from the semantic cache (never billed).",
                      },
                    },
                  },
                },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
            ...errorsFor("400", "401", "402", "429", "502", "503"),
          },
        },
      },
      "/v1/models": {
        get: {
          tags: ["Models"],
          summary: "List available models",
          description:
            "Queried live from each configured provider's own catalog and cached ~1h. " +
            "A provider that is unconfigured or unreachable degrades gracefully — it " +
            "contributes nothing rather than failing the whole call.",
          operationId: "listModels",
          responses: {
            "200": {
              description: "Every model reachable through the configured providers.",
              ...jsonBody({
                type: "object",
                properties: {
                  models: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        provider: { type: "string" },
                      },
                    },
                  },
                },
              }),
            },
            ...errorsFor("401"),
          },
        },
      },
      "/v1/jobs": {
        post: {
          tags: ["Jobs"],
          summary: "Submit an async job",
          description:
            "Both the job type and its payload are validated before enqueue, so a job " +
            "that could never succeed fails fast with 400 instead of consuming retries " +
            "and landing in the dead-letter queue.",
          operationId: "createJob",
          requestBody: {
            required: true,
            ...jsonBody({ $ref: "#/components/schemas/CreateJobRequest" }),
          },
          responses: {
            "202": {
              description: "Accepted and queued.",
              ...jsonBody({
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  status: { type: "string", enum: ["QUEUED"] },
                },
              }),
            },
            ...errorsFor("400", "401", "429"),
          },
        },
        get: {
          tags: ["Jobs"],
          summary: "List your organization's jobs",
          operationId: "listJobs",
          parameters: [
            {
              name: "status",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "DEAD_LETTER"],
              },
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 200 },
            },
          ],
          responses: {
            "200": { description: "Jobs belonging to your organization only." },
            ...errorsFor("400", "401"),
          },
        },
      },
      "/v1/jobs/{id}": {
        get: {
          tags: ["Jobs"],
          summary: "Fetch one job",
          description:
            "Another organization's job id returns 404, never 403 — the response must " +
            "not reveal whether the id exists.",
          operationId: "getJob",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": { description: "The job, including progress and result." },
            ...errorsFor("401", "404"),
          },
        },
      },
      "/v1/jobs/{id}/replay": {
        post: {
          tags: ["Jobs"],
          summary: "Replay a dead-lettered job",
          description:
            "Re-enqueues onto the original row so a job's history stays in one place. " +
            "Restricted to DEAD_LETTER jobs — replaying a running job would put two " +
            "executions on one row racing each other's status writes.",
          operationId: "replayJob",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "202": { description: "Re-queued." },
            ...errorsFor("400", "401", "404"),
          },
        },
      },
      "/v1/cache/stats": {
        get: {
          tags: ["Cache"],
          summary: "Semantic cache hit/miss counters",
          operationId: "getCacheStats",
          responses: {
            "200": { description: "Hit and miss counts for your organization." },
            ...errorsFor("401"),
          },
        },
      },
      "/v1/cache": {
        delete: {
          tags: ["Cache"],
          summary: "Invalidate cached responses",
          operationId: "flushCache",
          parameters: [
            {
              name: "keepModel",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Invalidate everything except this model's entries.",
            },
          ],
          responses: {
            "200": { description: "Number of entries removed." },
            ...errorsFor("401"),
          },
        },
      },
      "/v1/routing/stats": {
        get: {
          tags: ["Routing"],
          summary: "Provider latency and reliability",
          description:
            "Aggregate performance of shared upstream providers across all traffic " +
            "this gateway sends them — deliberately global, not per-tenant. No " +
            "tenant-specific data crosses organizations through this endpoint.",
          operationId: "getRoutingStats",
          responses: {
            "200": { description: "Rolling-window stats per provider." },
            ...errorsFor("401"),
          },
        },
      },
      "/v1/routing/ab-stats": {
        get: {
          tags: ["Routing"],
          summary: "Per-variant A/B request counts",
          description: "Scoped to your own organization's configured split.",
          operationId: "getAbStats",
          responses: {
            "200": { description: "Request counts per variant." },
            ...errorsFor("401"),
          },
        },
      },
      "/health": {
        get: {
          tags: ["Models"],
          summary: "Liveness probe",
          description: "Unauthenticated. Used as both readiness and liveness probe.",
          operationId: "health",
          security: [],
          responses: { "200": { description: "Service is up." } },
        },
      },
    },
  };
}

/**
 * Self-contained Swagger UI page.
 *
 * Deliberately loads swagger-ui-dist from a CDN rather than adding it as a
 * dependency: it would ship ~3MB of browser assets into every server image
 * for a page that is only ever opened by a human in a browser (which by
 * definition has internet access). No CDN, no docs page — the API itself is
 * unaffected.
 */
export function swaggerUiHtml(specUrl = "/openapi.json"): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CloudMesh API Reference</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
    <style>
      body { margin: 0; background: #fafafa; }
      .topbar { display: none; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.onload = () => {
        window.SwaggerUIBundle({
          url: ${JSON.stringify(specUrl)},
          dom_id: "#swagger-ui",
          deepLinking: true,
          persistAuthorization: true,
        });
      };
    </script>
  </body>
</html>`;
}
