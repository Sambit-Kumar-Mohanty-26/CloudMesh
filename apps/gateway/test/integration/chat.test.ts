import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApiKey, createTestApp, resetAll } from "./helpers.js";

describe("POST /v1/chat — auth", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetAll(app);
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid API key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer cm_live_not-a-real-key" },
      payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /v1/chat — non-streaming", () => {
  let app: FastifyInstance;
  let rawKey: string;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetAll(app);
    ({ rawKey } = await createTestApiKey());
  });

  it("returns a unified chat response from the mock provider", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "mock-echo", messages: [{ role: "user", content: "hello gateway" }] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe("mock");
    expect(body.model).toBe("mock-echo");
    expect(body.message.content).toBe("echo: hello gateway");
    expect(body.finishReason).toBe("stop");
    expect(body.usage).toBeDefined();
  });

  it("resolves model:'auto' to the configured default", async () => {
    // vitest.config.ts doesn't set DEFAULT_MODEL, so it falls back to the
    // schema default "gpt-4o-mini" — unconfigured in tests, so "auto"
    // should fail as a provider error (no key), not as an unknown model.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("PROVIDER_ERROR");
  });

  it("routes an unrecognized model-name shape to the Ollama catch-all, failing as 502 (no server), not a silent 400", async () => {
    // Model resolution is prefix-based, not an allowlist (see
    // providers/registry.ts) — anything not matching a known prefix falls
    // through to Ollama, since Ollama model names are arbitrary. In this
    // test env there's no real Ollama server, so it fails as a clean
    // provider error, not a fabricated "unknown model" 400.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "not-a-real-model", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().provider).toBe("ollama");
  });

  it("returns 502, not 500, for a real-provider model with no API key configured", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().provider).toBe("openai");
  });

  it("rejects an empty messages array", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "mock-echo", messages: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing model field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid message role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "mock-echo", messages: [{ role: "root", content: "hi" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an oversized messages array", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "mock-echo",
        messages: Array.from({ length: 201 }, () => ({ role: "user", content: "hi" })),
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/models", () => {
  let app: FastifyInstance;
  let rawKey: string;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetAll(app);
    ({ rawKey } = await createTestApiKey());
  });

  it("lists live models — only what's actually configured/reachable, not a static aspirational list", async () => {
    // Test env has no real OpenAI/Anthropic/Gemini keys and no reachable
    // Ollama server, so those providers' models() resolve to [] or reject
    // gracefully (see registry.ts's Promise.allSettled). Only the mock
    // provider, which needs no credentials, actually has something to list.
    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().models.map((m: { id: string }) => m.id);
    expect(ids).toEqual(["mock-echo"]);
  });
});
