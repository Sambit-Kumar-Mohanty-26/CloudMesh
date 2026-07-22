import { forceOpenCircuit } from "@cloudmesh/circuit-breaker";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApiKey, createTestApp, resetAll } from "./helpers.js";

describe("circuit breaker + fallback — through the real HTTP route", () => {
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

  it("an explicit model request gets 502 while the circuit is closed, then 503 once it trips", async () => {
    const headers = { authorization: `Bearer ${rawKey}` };
    const payload = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] };

    // CIRCUIT_FAILURE_THRESHOLD is 2 and RETRY_MAX_ATTEMPTS is 2 in the
    // test env, and OpenAI is unconfigured — so the FIRST request's own
    // two internal retry attempts already reach the failure threshold and
    // open the circuit right after its last attempt. That request still
    // surfaces the real ProviderError (502): the circuit only starts
    // blocking on the NEXT, separate call.
    const first = await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
    expect(first.statusCode).toBe(502);
    expect(first.json().code).toBe("PROVIDER_ERROR");

    // Circuit is now open — this call fails fast without even trying.
    const second = await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
    expect(second.statusCode).toBe(503);
    expect(second.json().code).toBe("SERVICE_UNAVAILABLE");
    expect(second.headers["retry-after"]).toBeDefined();
  });

  it("model:'auto' falls back to the next candidate once the primary's circuit is open", async () => {
    const headers = { authorization: `Bearer ${rawKey}` };

    // Force OpenAI's circuit open directly rather than tripping it through
    // failures — isolates this test from retry-count/threshold timing.
    await forceOpenCircuit(app.redis, "openai");

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers,
      payload: { model: "auto", messages: [{ role: "user", content: "fallback please" }] },
    });

    // AUTO_FALLBACK_MODELS="mock-echo" in the test env — DEFAULT_MODEL
    // (gpt-4o-mini/openai) is skipped since its circuit is open, so this
    // should succeed via the mock provider instead.
    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toBe("mock");
    expect(res.json().message.content).toBe("echo: fallback please");
  });

  it("model:'auto' returns 503 ALL_PROVIDERS_UNAVAILABLE when every candidate's circuit is open", async () => {
    const headers = { authorization: `Bearer ${rawKey}` };

    await forceOpenCircuit(app.redis, "openai");
    await forceOpenCircuit(app.redis, "mock");

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers,
      payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("ALL_PROVIDERS_UNAVAILABLE");
  });

  it("an explicit (non-auto) model request never gets silently swapped for a different model", async () => {
    const headers = { authorization: `Bearer ${rawKey}` };
    await forceOpenCircuit(app.redis, "openai");

    // Explicitly requesting gpt-4o-mini — even though mock-echo is
    // configured as an auto-fallback candidate and is healthy, this must
    // NOT be silently served by it.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers,
      payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("SERVICE_UNAVAILABLE");
  });
});
