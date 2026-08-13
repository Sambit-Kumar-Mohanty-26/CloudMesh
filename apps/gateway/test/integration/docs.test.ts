import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApiKey, createTestApp } from "./helpers.js";

/**
 * The OpenAPI document is generated from the same Zod schemas the handlers
 * validate with, so it cannot drift from what the server enforces. What it
 * CAN drift on is the route list — paths are enumerated by hand in
 * packages/openapi, not derived from Fastify's router. These tests close
 * that gap by checking every documented path against the routes the app
 * actually registered.
 */
describe("OpenAPI document and Swagger UI", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("serves the spec without authentication", async () => {
    // A developer must be able to read the docs before they have a key.
    const res = await app.inject({ method: "GET", url: "/openapi.json" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ openapi: "3.1.0" });
  });

  it("serves Swagger UI as HTML, not a JSON download", async () => {
    const res = await app.inject({ method: "GET", url: "/docs" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("swagger-ui");
  });

  it("documents only paths the gateway actually serves", async () => {
    const spec = (await app.inject({ method: "GET", url: "/openapi.json" })).json() as {
      paths: Record<string, Record<string, unknown>>;
    };

    // `hasRoute` consults Fastify's actual router. printRoutes() renders a
    // prefix TREE ("/v1/jobs" with a "/:id" child), so nested paths never
    // appear as flat strings there and a substring check silently passes
    // or fails for the wrong reason.
    for (const [path, operations] of Object.entries(spec.paths)) {
      // OpenAPI templating -> Fastify params: /v1/jobs/{id} -> /v1/jobs/:id
      const url = path.replace(/\{(\w+)\}/g, ":$1");

      for (const method of Object.keys(operations)) {
        expect(["get", "post", "put", "patch", "delete"]).toContain(method);
        expect(
          app.hasRoute({ method: method.toUpperCase() as "GET", url }),
          `${method.toUpperCase()} ${path} is documented but not registered on the server`,
        ).toBe(true);
      }
    }
  });

  it("derives the chat request body from the real validation schema", async () => {
    // Proves the spec is generated, not hand-written: these constraints
    // exist only in chatRequestSchema.
    const spec = (await app.inject({ method: "GET", url: "/openapi.json" })).json() as {
      components: { schemas: { ChatRequest: Record<string, unknown> } };
    };
    const chat = spec.components.schemas.ChatRequest;

    expect(chat.required).toEqual(expect.arrayContaining(["model", "messages"]));

    const props = chat.properties as Record<string, Record<string, unknown>>;
    expect(props.temperature).toMatchObject({ minimum: 0, maximum: 2 });
    expect(props.messages).toMatchObject({ minItems: 1, maxItems: 200 });
  });

  it("rejects an undocumented body exactly as the spec says it will", async () => {
    // The spec promises 400 + a `code` field for an invalid body; this is
    // the same schema, so the promise has to hold against the real route.
    const { rawKey } = await createTestApiKey("Docs Org", 10);

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "mock-echo", messages: [], temperature: 99 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("code");
  });

  it("never leaks provider credentials or tenant data into the document", async () => {
    const body = (await app.inject({ method: "GET", url: "/openapi.json" })).body;

    for (const secret of ["sk-", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DATABASE_URL", "JWT"]) {
      expect(body).not.toContain(secret);
    }
  });
});
