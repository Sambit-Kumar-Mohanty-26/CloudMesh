import { forceOpenCircuit, resetCircuit } from "@cloudmesh/circuit-breaker";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApiKey, createTestApp, resetAll } from "./helpers.js";

describe("POST /v1/chat — routing engine (Phase 8)", () => {
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
  afterEach(async () => {
    await resetCircuit(app.redis, "openai");
    await resetCircuit(app.redis, "mock");
  });

  it("uses the org's routing_preset for auto resolution", async () => {
    const { rawKey } = await createTestApiKey("Preset Org", 60, {
      routing_preset: "cost_optimized",
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toBe("mock");
  });

  it("falls back to the default preset for an org with no routing_preset set", async () => {
    const { rawKey } = await createTestApiKey("No Preset Org", 60, {});
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toBe("mock");
  });

  it("an explicit model request is never affected by routing_preset or ab_config", async () => {
    const { rawKey } = await createTestApiKey("Explicit Org", 60, {
      routing_preset: "latency_optimized",
      ab_config: { "mock-echo": 0.1, "gpt-4o-mini": 0.9 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toBe("mock");
  });

  it("routes auto requests through the org's ab_config, distributing across variants", async () => {
    const { rawKey } = await createTestApiKey("AB Org", 60, {
      ab_config: { "mock-echo": 1 }, // single-variant config: deterministic, still exercises the AB path
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toBe("mock");

    const abStats = await app.inject({
      method: "GET",
      url: "/v1/routing/ab-stats",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(abStats.json()).toEqual({ "mock-echo": 1 });
  });

  it("falls through to preset-scored routing when every ab_config variant is circuit-excluded", async () => {
    await forceOpenCircuit(app.redis, "mock");
    const { rawKey } = await createTestApiKey("AB Fallback Org", 60, {
      ab_config: { "mock-echo": 1 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    });
    // The A/B config's only variant (mock-echo) is excluded, so this falls
    // through to preset-scored routing over [DEFAULT_MODEL,
    // ...AUTO_FALLBACK_MODELS] — DEFAULT_MODEL (gpt-4o-mini/openai) has its
    // OWN, still-closed circuit, so the fallthrough correctly finds and
    // attempts it (proof the fallthrough path is real, not a no-op), and
    // that fails as an ordinary 502 (unconfigured in this test env) rather
    // than silently succeeding via the excluded A/B variant.
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("PROVIDER_ERROR");
  });

  it("reports unavailability when the ab_config fallback ALSO has nothing left (every candidate excluded)", async () => {
    await forceOpenCircuit(app.redis, "mock");
    await forceOpenCircuit(app.redis, "openai");
    const { rawKey } = await createTestApiKey("AB Total Outage Org", 60, {
      ab_config: { "mock-echo": 1 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("ALL_PROVIDERS_UNAVAILABLE");
  });

  it("GET /v1/routing/ab-stats returns {} for an org with no ab_config", async () => {
    const { rawKey } = await createTestApiKey("No AB Org");
    const res = await app.inject({
      method: "GET",
      url: "/v1/routing/ab-stats",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });

  it("GET /v1/routing/stats requires auth and reports real-time provider stats after a call", async () => {
    const unauth = await app.inject({ method: "GET", url: "/v1/routing/stats" });
    expect(unauth.statusCode).toBe(401);

    const { rawKey } = await createTestApiKey("Stats Org");
    await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/routing/stats",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json();
    expect(stats.mock.sampleCount).toBeGreaterThanOrEqual(1);
    expect(stats.mock.successRate).toBe(1);
  });

  it("a malformed ab_config (non-numeric weights) is ignored, not a 500", async () => {
    const { rawKey } = await createTestApiKey("Hostile AB Org", 60, {
      ab_config: { "mock-echo": "not-a-number", "gpt-4o-mini": -5 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    });
    // Malformed ab_config coerces to undefined (see featureFlags.ts) — falls
    // through to ordinary preset-scored routing instead of crashing.
    expect(res.statusCode).toBe(200);
  });

  it("an unrecognized routing_preset string falls back to the default rather than crashing", async () => {
    const { rawKey } = await createTestApiKey("Bad Preset Org", 60, {
      routing_preset: "made_up_preset_name",
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
  });

  it("never lets one org's A/B stats leak into another org's ab-stats response", async () => {
    const orgA = await createTestApiKey("AB Stats Org A", 60, { ab_config: { "mock-echo": 1 } });
    const orgB = await createTestApiKey("AB Stats Org B", 60, { ab_config: { "mock-echo": 1 } });

    await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${orgA.rawKey}` },
      payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    });

    const statsB = await app.inject({
      method: "GET",
      url: "/v1/routing/ab-stats",
      headers: { authorization: `Bearer ${orgB.rawKey}` },
    });
    expect(statsB.json()).toEqual({ "mock-echo": 0 });
  });
});
