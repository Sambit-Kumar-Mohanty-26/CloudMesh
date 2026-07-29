import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTraceContext } from "../src/context.js";
import { withSpan } from "../src/spans.js";

/**
 * `startTelemetry()` (tracing.ts) is never exercised here — it opens a real
 * OTLP network exporter and patches global modules (http/undici/ioredis),
 * neither of which belongs in a unit test. Instead, these tests register a
 * `BasicTracerProvider` with an in-memory exporter directly, the same
 * "prove the instrumentation logic without needing a live collector"
 * pattern this codebase already uses for MockAgent-based provider adapter
 * tests. Every OTHER test file in this repo (including this package's own
 * consumers, once wired into apps/*) never registers a tracer provider at
 * all — `withSpan`/`getTraceContext` must be safe no-ops without one, which
 * this file can't itself prove (it always registers a provider in
 * beforeEach); see noopWithoutProvider.test.ts for that guarantee, checked
 * in a file that never touches the global tracer provider.
 */
// Registered ONCE for the whole file, not per-test: @opentelemetry/api's
// global registration guards against a second `setGlobalTracerProvider`
// call unless `trace.disable()` fully unregisters it first, and that
// disable/re-register dance raced `provider.shutdown()` across tests in
// practice — spans from the 2nd test onward silently never reached the
// exporter. `InMemorySpanExporter.reset()` (called per-test below) is the
// exporter's own documented way to get a clean slate between tests without
// touching global registration at all.
//
// A ContextManager must ALSO be registered explicitly — `BasicTracerProvider`
// (unlike `NodeSDK`, which wires this up as part of `sdk.start()` in real
// production use) does not register one on its own. Without it,
// `context.active()` always reads the empty root context, so
// `getTraceContext()` never sees a span and child spans started inside
// `withSpan` never pick up their parent — both genuinely failed with a
// bare `BasicTracerProvider` before this was added.
let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let contextManager: AsyncHooksContextManager;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  contextManager = new AsyncHooksContextManager().enable();
  context.setGlobalContextManager(contextManager);
});

beforeEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
  contextManager.disable();
  context.disable();
  trace.disable();
});

describe("withSpan", () => {
  it("creates a span with the given name and attributes, marked OK on success", async () => {
    const result = await withSpan("semantic_cache", { orgId: "org_1", hit: true }, async () => {
      return "ok";
    });
    expect(result).toBe("ok");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("semantic_cache");
    expect(spans[0]!.attributes).toMatchObject({ orgId: "org_1", hit: true });
    expect(spans[0]!.status.code).toBe(SpanStatusCode.OK);
  });

  it("records the exception and marks the span ERROR, then still re-throws", async () => {
    await expect(
      withSpan("llm_provider", { provider: "openai" }, async () => {
        throw new Error("provider unreachable");
      }),
    ).rejects.toThrow("provider unreachable");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]!.status.message).toBe("provider unreachable");
    expect(spans[0]!.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("always ends the span, even when fn throws", async () => {
    await withSpan("a", {}, async () => "done").catch(() => undefined);
    await withSpan("b", {}, async () => {
      throw new Error("boom");
    }).catch(() => undefined);

    // Both spans reached the exporter — neither was left open.
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("nests correctly: a child span started inside withSpan has the parent's trace id", async () => {
    await withSpan("parent", {}, async () => {
      await withSpan("child", {}, async () => "x");
    });

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "parent")!;
    const child = spans.find((s) => s.name === "child")!;
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });
});

describe("getTraceContext", () => {
  it("returns the active span's trace/span ids from inside withSpan", async () => {
    let captured: ReturnType<typeof getTraceContext>;
    await withSpan("auth", {}, async () => {
      captured = getTraceContext();
    });

    const span = exporter.getFinishedSpans()[0]!;
    expect(captured).toEqual({
      trace_id: span.spanContext().traceId,
      span_id: span.spanContext().spanId,
    });
  });

  it("returns undefined when there is no active span", () => {
    expect(getTraceContext()).toBeUndefined();
  });
});
