import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApiKey, createTestApp, resetAll } from "./helpers.js";

describe("POST /v1/chat — rate limiting", () => {
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

  it("allows exactly rate_limit_rpm requests, then denies the next with 429", async () => {
    const { rawKey } = await createTestApiKey("Org", 2);
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "hi" }] };
    const headers = { authorization: `Bearer ${rawKey}` };

    const first = await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
    const second = await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
    const third = await app.inject({ method: "POST", url: "/v1/chat", headers, payload });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("sets a positive integer Retry-After header on 429", async () => {
    const { rawKey } = await createTestApiKey("Org", 1);
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "hi" }] };
    const headers = { authorization: `Bearer ${rawKey}` };

    await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
    const denied = await app.inject({ method: "POST", url: "/v1/chat", headers, payload });

    expect(denied.statusCode).toBe(429);
    const retryAfter = Number(denied.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("limits are per-key — exhausting one org's quota doesn't affect another's", async () => {
    const { rawKey: keyA } = await createTestApiKey("Org A", 1);
    const { rawKey: keyB } = await createTestApiKey("Org B", 1);
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "hi" }] };

    await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${keyA}` },
      payload,
    });
    const orgAExhausted = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${keyA}` },
      payload,
    });
    const orgBStillFresh = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${keyB}` },
      payload,
    });

    expect(orgAExhausted.statusCode).toBe(429);
    expect(orgBStillFresh.statusCode).toBe(200);
  });

  it("does not rate-limit GET /v1/models even after the chat quota is exhausted", async () => {
    const { rawKey } = await createTestApiKey("Org", 1);
    const headers = { authorization: `Bearer ${rawKey}` };
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "hi" }] };

    await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
    const chatDenied = await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
    expect(chatDenied.statusCode).toBe(429);

    const models = await app.inject({ method: "GET", url: "/v1/models", headers });
    expect(models.statusCode).toBe(200);
  });

  it("a rejected request never reaches the provider (no idle token spent on a 429)", async () => {
    // Sanity check on ordering: rate limiting runs as a preHandler before
    // the route body, so a denied request shouldn't produce a mock-echo
    // response body at all.
    const { rawKey } = await createTestApiKey("Org", 1);
    const headers = { authorization: `Bearer ${rawKey}` };
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "hi" }] };

    await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
    const denied = await app.inject({ method: "POST", url: "/v1/chat", headers, payload });

    expect(denied.json()).not.toHaveProperty("message");
  });
});
