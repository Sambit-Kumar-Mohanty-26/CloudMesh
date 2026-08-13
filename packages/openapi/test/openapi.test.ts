import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildOpenApiDocument, swaggerUiHtml } from "../src/index.js";

/**
 * The generated document is plain JSON that these tests index into freely.
 * Modelling the whole OpenAPI 3.1 type here would add no safety to
 * assertions that are checking exact literal values anyway — one
 * deliberately loose alias, used everywhere, beats a cast per assertion.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** Stand-ins with the same shape as the gateway's real schemas. The point
 *  of these tests is the generation, not the specific fields. */
const schemas = {
  chatRequest: z.object({
    model: z.string().min(1).max(100),
    messages: z
      .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
      .min(1)
      .max(200),
    temperature: z.number().min(0).max(2).optional(),
  }),
  createJob: z.object({ type: z.string(), payload: z.unknown() }),
  listJobsQuery: z.object({ limit: z.coerce.number().int().optional() }),
};

describe("buildOpenApiDocument", () => {
  it("produces a valid OpenAPI 3.1 envelope", () => {
    const doc = buildOpenApiDocument(schemas) as Doc;

    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("CloudMesh API");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
  });

  it("derives request schemas from Zod rather than a hand-written copy", () => {
    // These constraints exist only on the Zod schema above — if generation
    // broke and someone hand-wrote the spec, they would not survive.
    const doc = buildOpenApiDocument(schemas) as Doc;
    const chat = doc.components.schemas.ChatRequest;

    expect(chat.properties.temperature).toMatchObject({ minimum: 0, maximum: 2 });
    expect(chat.properties.messages).toMatchObject({ minItems: 1, maxItems: 200 });
    expect(chat.required).toEqual(expect.arrayContaining(["model", "messages"]));
  });

  it("strips the JSON Schema dialect declaration, which OpenAPI implies", () => {
    const doc = buildOpenApiDocument(schemas) as Doc;

    expect(doc.components.schemas.ChatRequest).not.toHaveProperty("$schema");
  });

  it("declares bearer auth globally and exempts the health probe", () => {
    const doc = buildOpenApiDocument(schemas) as Doc;

    expect(doc.security).toEqual([{ ApiKeyAuth: [] }]);
    expect(doc.components.securitySchemes.ApiKeyAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    // /health is used as a k8s probe and must not require a key.
    expect(doc.paths["/health"].get.security).toEqual([]);
  });

  it("uses the configured public URL so Try-It-Out targets the real host", () => {
    const doc = buildOpenApiDocument(schemas, {
      serverUrl: "https://api.example.com",
    }) as Doc;

    expect(doc.servers).toEqual([{ url: "https://api.example.com" }]);
  });

  it("documents the error shape callers are told to switch on", () => {
    const doc = buildOpenApiDocument(schemas) as Doc;
    const chat429 = doc.paths["/v1/chat"].post.responses["429"];

    expect(chat429.content["application/json"].schema.required).toEqual(["error", "code"]);
  });

  it("documents streaming as an alternative content type on the same 200", () => {
    const doc = buildOpenApiDocument(schemas) as Doc;
    const ok = doc.paths["/v1/chat"].post.responses["200"];

    expect(Object.keys(ok.content)).toEqual(
      expect.arrayContaining(["application/json", "text/event-stream"]),
    );
  });

  it("gives every operation a unique operationId (SDK generators require it)", () => {
    const doc = buildOpenApiDocument(schemas) as Doc;
    const ids: string[] = [];

    for (const operations of Object.values(doc.paths) as Doc[]) {
      for (const op of Object.values(operations)) {
        if (op.operationId) ids.push(op.operationId);
      }
    }

    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("swaggerUiHtml", () => {
  it("points at the given spec URL", () => {
    expect(swaggerUiHtml("/openapi.json")).toContain('"/openapi.json"');
  });

  it("JSON-encodes the spec URL so it cannot break out of the script", () => {
    // The URL is a server-controlled constant today, but encoding it means
    // this stays safe if it ever becomes configurable.
    const html = swaggerUiHtml('"; alert(1); //');

    expect(html).not.toContain('url: "; alert(1)');
    expect(html).toContain('"\\"; alert(1); //"');
  });
});
