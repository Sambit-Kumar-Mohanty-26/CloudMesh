import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApiKey, createTestApp, resetAll } from "./helpers.js";

describe("POST /v1/chat — idempotency", () => {
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

  it("replays the exact same result for a repeated Idempotency-Key, without re-invoking the provider", async () => {
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "same request" }] };
    const headers = { authorization: `Bearer ${rawKey}`, "idempotency-key": "req-abc-123" };

    const first = await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
    const second = await app.inject({ method: "POST", url: "/v1/chat", headers, payload });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(first.headers["idempotent-replay"]).toBeUndefined();

    // The mock provider mints a fresh id every call — identical ids across
    // two calls is direct proof the second one was served from cache, not
    // by calling the provider again.
    expect(second.json().id).toBe(first.json().id);
    expect(second.json()).toEqual(first.json());
  });

  it("does NOT replay across different idempotency keys", async () => {
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "same request" }] };

    const first = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": "key-one" },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": "key-two" },
      payload,
    });

    expect(first.json().id).not.toBe(second.json().id);
  });

  it("does NOT replay when no idempotency key is sent at all", async () => {
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "same request" }] };
    const headers = { authorization: `Bearer ${rawKey}` };

    const first = await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
    const second = await app.inject({ method: "POST", url: "/v1/chat", headers, payload });

    expect(first.json().id).not.toBe(second.json().id);
  });

  it("scopes idempotency keys per-org — two orgs reusing the same literal key don't collide", async () => {
    const { rawKey: rawKeyB } = await createTestApiKey("Second Org");
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "same request" }] };
    const sameKey = "shared-literal-key";

    const fromOrgA = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": sameKey },
      payload,
    });
    const fromOrgB = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKeyB}`, "idempotency-key": sameKey },
      payload,
    });

    expect(fromOrgA.json().id).not.toBe(fromOrgB.json().id);
    expect(fromOrgB.headers["idempotent-replay"]).toBeUndefined();
  });

  it("also replays a streamed original request as a cached non-streaming JSON response", async () => {
    const headers = { authorization: `Bearer ${rawKey}`, "idempotency-key": "stream-then-replay" };

    const streamed = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers,
      payload: {
        model: "mock-echo",
        messages: [{ role: "user", content: "stream me" }],
        stream: true,
      },
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.headers["content-type"]).toContain("text/event-stream");

    const replay = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers,
      payload: { model: "mock-echo", messages: [{ role: "user", content: "stream me" }] },
    });

    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(replay.json().message.content.trim()).toBe("echo: stream me");
  });
});
