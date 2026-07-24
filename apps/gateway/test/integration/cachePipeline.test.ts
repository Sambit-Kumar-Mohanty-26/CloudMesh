import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApiKey, createTestApp, resetAll } from "./helpers.js";

function chatSpy(app: FastifyInstance) {
  const resolved = app.models.resolve("mock-echo")!;
  return vi.spyOn(resolved.provider, "chat");
}

describe("POST /v1/chat — semantic cache (opt-in via feature flags)", () => {
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

  it("does NOT cache when the org's semantic_cache flag is off (default)", async () => {
    const { rawKey } = await createTestApiKey("No Cache Org", 60, {});
    const spy = chatSpy(app);
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "explain JWT" }] };

    const first = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload,
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(first.json().id).not.toBe(second.json().id);
  });

  it("hits the cache on an exact repeat and skips the provider entirely", async () => {
    const { rawKey } = await createTestApiKey("Cache Org", 60, { semantic_cache: true });
    const spy = chatSpy(app);
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "explain JWT" }] };

    const first = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    // The provider generates a fresh random id every real invocation — an
    // identical id on the second response proves it's the stored result,
    // not a new call that happened to echo the same text.
    expect(second.json().id).toBe(first.json().id);

    const stats = await app.inject({
      method: "GET",
      url: "/v1/cache/stats",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(stats.json()).toEqual({ hits: 1, misses: 1 });
  });

  it("misses and calls the provider fresh for a different prompt", async () => {
    const { rawKey } = await createTestApiKey("Cache Org", 60, { semantic_cache: true });
    const spy = chatSpy(app);

    await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "mock-echo", messages: [{ role: "user", content: "explain JWT" }] },
    });
    await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "mock-echo", messages: [{ role: "user", content: "what's the weather" }] },
    });

    expect(spy).toHaveBeenCalledTimes(2);
    const stats = await app.inject({
      method: "GET",
      url: "/v1/cache/stats",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(stats.json()).toEqual({ hits: 0, misses: 2 });
  });

  it("never serves org B a response cached by org A for the identical prompt", async () => {
    const orgA = await createTestApiKey("Org A", 60, { semantic_cache: true });
    const orgB = await createTestApiKey("Org B", 60, { semantic_cache: true });
    const spy = chatSpy(app);
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "explain JWT" }] };

    await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${orgA.rawKey}` },
      payload,
    });
    await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${orgB.rawKey}` },
      payload,
    });

    // Org B must get its OWN provider call, not org A's cached response.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("DELETE /v1/cache flushes the org's cache so a repeat becomes a miss again", async () => {
    const { rawKey } = await createTestApiKey("Cache Org", 60, { semantic_cache: true });
    const spy = chatSpy(app);
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "explain JWT" }] };

    const first = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload,
    });

    const flush = await app.inject({
      method: "DELETE",
      url: "/v1/cache",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(flush.statusCode).toBe(200);
    expect(flush.json().deleted).toBe(1);

    const afterFlush = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload,
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(afterFlush.json().id).not.toBe(first.json().id);
  });
});

describe("POST /v1/chat — request dedup (opt-in via feature flags)", () => {
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

  it("coalesces concurrent identical requests into a single provider call", async () => {
    const { rawKey } = await createTestApiKey("Dedup Org", 60, { request_dedup: true });
    const spy = chatSpy(app);
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "explain JWT" }] };

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: "POST",
          url: "/v1/chat",
          headers: { authorization: `Bearer ${rawKey}` },
          payload,
        }),
      ),
    );

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const ids = new Set(responses.map((r) => r.json().id));
    expect(ids.size).toBe(1);
  });

  it("never coalesces two different orgs' identical concurrent requests together", async () => {
    const orgA = await createTestApiKey("Dedup Org A", 60, { request_dedup: true });
    const orgB = await createTestApiKey("Dedup Org B", 60, { request_dedup: true });
    const spy = chatSpy(app);
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "explain JWT" }] };

    await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${orgA.rawKey}` },
        payload,
      }),
      app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${orgB.rawKey}` },
        payload,
      }),
    ]);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does NOT coalesce when the org's request_dedup flag is off (default)", async () => {
    const { rawKey } = await createTestApiKey("No Dedup Org", 60, {});
    const spy = chatSpy(app);
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "explain JWT" }] };

    await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${rawKey}` },
        payload,
      }),
      app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${rawKey}` },
        payload,
      }),
    ]);

    expect(spy).toHaveBeenCalledTimes(2);
  });
});
