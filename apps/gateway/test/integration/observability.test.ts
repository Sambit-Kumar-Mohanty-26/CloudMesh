import { getAdminPrisma, seedBillingPlans } from "@cloudmesh/db";
import { registry } from "@cloudmesh/metrics";
import { context, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApiKey, createTestApp, resetAll } from "./helpers.js";

/**
 * Real spans/metrics through a real /v1/chat request — neither is
 * exercised by any other test file. Every other integration test builds
 * the app via createTestApp()/buildApp() directly, never through an app's
 * src/instrument.ts bootstrap (see @cloudmesh/telemetry's tracing.ts doc
 * comment for why that's deliberate), so `withSpan` calls throughout the
 * codebase have silently been no-ops in every test run until this file
 * registers a real tracer provider + context manager, the same pattern
 * @cloudmesh/telemetry's own spans.test.ts uses.
 *
 * Metrics are different: `@cloudmesh/metrics`' registry is a real,
 * always-active singleton regardless of whether telemetry's SDK was ever
 * started (prom-client has no such "no SDK registered" no-op mode) — every
 * OTHER integration test file in this workspace has therefore already been
 * incrementing these same counters as a side effect of exercising
 * POST /v1/chat, just never asserting on them. `registry.resetMetrics()`
 * in beforeEach is what makes this file's own assertions deterministic
 * despite that shared, cross-file accumulation.
 */
const admin = getAdminPrisma();

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let contextManager: AsyncHooksContextManager;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  contextManager = new AsyncHooksContextManager().enable();
  context.setGlobalContextManager(contextManager);
});

afterAll(async () => {
  await provider.shutdown();
  contextManager.disable();
  context.disable();
  trace.disable();
});

describe("observability (Phase 12)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetAll(app);
    await seedBillingPlans();
    exporter.reset();
    registry.resetMetrics();
  });

  describe("tracing", () => {
    it("creates auth, rate_limiter, and llm_provider spans for a real chat request", async () => {
      const { rawKey } = await createTestApiKey("Tracing Org");
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200);

      const names = exporter.getFinishedSpans().map((s) => s.name);
      expect(names).toContain("auth");
      expect(names).toContain("rate_limiter");
      expect(names).toContain("llm_provider");
    });

    it("records a failed auth attempt as an ERROR-status auth span", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: "Bearer cm_live_totally-invalid" },
        payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(401);

      const authSpan = exporter.getFinishedSpans().find((s) => s.name === "auth");
      expect(authSpan?.attributes.result).toBe("invalid_key");
      expect(authSpan?.status.code).toBe(2); // SpanStatusCode.ERROR
    });

    it("creates a billing span when billing_enforcement is on", async () => {
      const { rawKey } = await createTestApiKey("Billing Span Org", 60, {
        billing_enforcement: true,
      });
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200);

      expect(exporter.getFinishedSpans().map((s) => s.name)).toContain("billing");
    });

    it("creates a semantic_cache span when the org has opted in", async () => {
      const { rawKey } = await createTestApiKey("Cache Span Org", 60, { semantic_cache: true });
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200);

      const cacheSpan = exporter.getFinishedSpans().find((s) => s.name === "semantic_cache");
      expect(cacheSpan).toBeDefined();
      expect(cacheSpan?.attributes.hit).toBe(false);
    });

    // NOT tested here: that auth/rate_limiter/semantic_cache/llm_provider/
    // billing all share one trace_id for a single real request. In
    // production that's a property of Node's `HttpInstrumentation`
    // (registered by @cloudmesh/telemetry's startTelemetry(), never called
    // in any test) creating a root span that stays active in
    // AsyncLocalStorage context across Fastify's whole hook chain.
    // `app.inject()` bypasses Node's real http server entirely — no
    // request ever reaches the instrumented `http` module — so each
    // top-level withSpan() call in this test file genuinely starts its own
    // independent root trace, correctly reproducing the *absence* of an
    // HTTP root span, not a bug in the span-wrapping code itself. This
    // was caught by writing the test and watching it fail with 3
    // independent trace ids instead of a false-positive "should pass"
    // assumption — verified manually against a real request through
    // Jaeger instead (see CLAUDE.md's Phase 12 notes).
  });

  describe("metrics", () => {
    it("GET /metrics is reachable without authentication", async () => {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
    });

    it("reflects request/token/cost counters after a real chat request", async () => {
      const { rawKey, orgId } = await createTestApiKey("Metrics Org");
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200);

      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.body).toContain(
        `cloudmesh_requests_total{org="${orgId}",model="mock-echo",status="200"} 1`,
      );
      expect(metrics.body).toMatch(
        new RegExp(
          `cloudmesh_tokens_total\\{org="${orgId}",model="mock-echo",type="prompt"\\} \\d`,
        ),
      );
      expect(metrics.body).toContain(`cloudmesh_cost_usd_total{org="${orgId}",model="mock-echo"}`);
    });

    it("reflects rate_limit_rejected_total once an org exhausts its quota", async () => {
      const { rawKey, orgId } = await createTestApiKey("Rate Limited Metrics Org", 1);
      await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
      });
      const rejected = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { model: "mock-echo", messages: [{ role: "user", content: "hi" }] },
      });
      expect(rejected.statusCode).toBe(429);

      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.body).toContain(`cloudmesh_rate_limit_rejected_total{org="${orgId}"} 1`);
    });

    it("reflects cache_outcomes_total for a semantic-cache-enabled org", async () => {
      const { rawKey } = await createTestApiKey("Cache Metrics Org", 60, {
        semantic_cache: true,
      });
      // Same prompt twice: first is a miss (embedding computed, provider
      // called), second hits the entry the first call wrote.
      const payload = { model: "mock-echo", messages: [{ role: "user", content: "cache me" }] };
      await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${rawKey}` },
        payload,
      });
      await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${rawKey}` },
        payload,
      });

      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.body).toContain('cloudmesh_cache_outcomes_total{outcome="miss"} 1');
      expect(metrics.body).toContain('cloudmesh_cache_outcomes_total{outcome="hit"} 1');
    });

    it("never lets one org's metrics vanish behind another's under the same label set", async () => {
      const a = await createTestApiKey("Metrics Org A");
      const b = await createTestApiKey("Metrics Org B");
      const payload = { model: "mock-echo", messages: [{ role: "user", content: "hi" }] };

      await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${a.rawKey}` },
        payload,
      });
      await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${b.rawKey}` },
        payload,
      });
      await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${b.rawKey}` },
        payload,
      });

      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.body).toContain(
        `cloudmesh_requests_total{org="${a.orgId}",model="mock-echo",status="200"} 1`,
      );
      expect(metrics.body).toContain(
        `cloudmesh_requests_total{org="${b.orgId}",model="mock-echo",status="200"} 2`,
      );
    });
  });

  it("orgId, when known, is a no-op sanity check that the seeded org actually exists", async () => {
    // Guards the test file itself: createTestApiKey's org must be real and
    // queryable, or every test above is silently asserting against data
    // that was never actually persisted.
    const { orgId } = await createTestApiKey("Sanity Org");
    const org = await admin.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.id).toBe(orgId);
  });
});
