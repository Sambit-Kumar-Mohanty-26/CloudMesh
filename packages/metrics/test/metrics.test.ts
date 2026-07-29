import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cacheOutcomesTotal,
  circuitBreakerState,
  costUsdTotal,
  rateLimitRejectedTotal,
  registerMetricsRoute,
  registry,
  requestDurationMs,
  requestsTotal,
  setCircuitBreakerState,
  tokensTotal,
} from "../src/index.js";

// resetMetrics() clears accumulated values between tests without touching
// registration (re-registering the same-named metric a second time throws)
// — the same "reset state, don't re-create the object" approach
// packages/telemetry's InMemorySpanExporter.reset() uses for the identical
// reason.
beforeEach(() => {
  registry.resetMetrics();
});

describe("metric definitions", () => {
  it("requestsTotal increments per label combination independently", async () => {
    requestsTotal.inc({ org: "org_1", model: "gpt-4o", status: "200" });
    requestsTotal.inc({ org: "org_1", model: "gpt-4o", status: "200" });
    requestsTotal.inc({ org: "org_2", model: "gpt-4o", status: "429" });

    const value = await requestsTotal.get();
    const a = value.values.find((v) => v.labels.org === "org_1" && v.labels.status === "200");
    const b = value.values.find((v) => v.labels.org === "org_2" && v.labels.status === "429");
    expect(a?.value).toBe(2);
    expect(b?.value).toBe(1);
  });

  it("requestDurationMs records observations into the configured buckets", async () => {
    requestDurationMs.observe({ org: "org_1", model: "gpt-4o" }, 42);
    requestDurationMs.observe({ org: "org_1", model: "gpt-4o" }, 4200);

    const value = await requestDurationMs.get();
    const sum = value.values.find((v) => v.metricName === "cloudmesh_request_duration_ms_sum");
    expect(sum?.value).toBe(42 + 4200);
  });

  it("tokensTotal and costUsdTotal track org/model/type separately", async () => {
    tokensTotal.inc({ org: "org_1", model: "gpt-4o", type: "prompt" }, 100);
    tokensTotal.inc({ org: "org_1", model: "gpt-4o", type: "completion" }, 40);
    costUsdTotal.inc({ org: "org_1", model: "gpt-4o" }, 0.0031);

    const tokens = await tokensTotal.get();
    const prompt = tokens.values.find((v) => v.labels.type === "prompt");
    const completion = tokens.values.find((v) => v.labels.type === "completion");
    expect(prompt?.value).toBe(100);
    expect(completion?.value).toBe(40);

    const cost = await costUsdTotal.get();
    expect(cost.values[0]?.value).toBeCloseTo(0.0031, 6);
  });

  it("rateLimitRejectedTotal increments per org", async () => {
    rateLimitRejectedTotal.inc({ org: "org_1" });
    rateLimitRejectedTotal.inc({ org: "org_1" });
    const value = await rateLimitRejectedTotal.get();
    expect(value.values.find((v) => v.labels.org === "org_1")?.value).toBe(2);
  });

  it("cacheOutcomesTotal separates hit and miss counts", async () => {
    cacheOutcomesTotal.inc({ outcome: "hit" });
    cacheOutcomesTotal.inc({ outcome: "hit" });
    cacheOutcomesTotal.inc({ outcome: "miss" });

    const value = await cacheOutcomesTotal.get();
    expect(value.values.find((v) => v.labels.outcome === "hit")?.value).toBe(2);
    expect(value.values.find((v) => v.labels.outcome === "miss")?.value).toBe(1);
  });

  it("setCircuitBreakerState maps closed/half_open/open to 0/1/2", async () => {
    setCircuitBreakerState("openai", "closed");
    setCircuitBreakerState("anthropic", "half_open");
    setCircuitBreakerState("gemini", "open");

    const value = await circuitBreakerState.get();
    expect(value.values.find((v) => v.labels.provider === "openai")?.value).toBe(0);
    expect(value.values.find((v) => v.labels.provider === "anthropic")?.value).toBe(1);
    expect(value.values.find((v) => v.labels.provider === "gemini")?.value).toBe(2);
  });

  it("setCircuitBreakerState overwrites the same provider's prior value, not accumulates", async () => {
    setCircuitBreakerState("openai", "closed");
    setCircuitBreakerState("openai", "open");

    const value = await circuitBreakerState.get();
    const openaiValues = value.values.filter((v) => v.labels.provider === "openai");
    expect(openaiValues).toHaveLength(1);
    expect(openaiValues[0]?.value).toBe(2);
  });
});

describe("registerMetricsRoute", () => {
  it("GET /metrics returns Prometheus exposition text with the right content-type", async () => {
    const app = Fastify();
    await app.register(registerMetricsRoute);
    await app.ready();

    requestsTotal.inc({ org: "org_1", model: "gpt-4o", status: "200" });

    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("cloudmesh_requests_total");
    expect(res.body).toContain('org="org_1"');

    await app.close();
  });

  it("includes prom-client's own default process metrics", async () => {
    const app = Fastify();
    await app.register(registerMetricsRoute);
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("process_cpu_user_seconds_total");

    await app.close();
  });
});
