import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

export const tracer = trace.getTracer("cloudmesh");

/**
 * Runs `fn` inside a new active child span named `name`, recording any
 * thrown error on the span (exception event + ERROR status) before
 * re-throwing — a failure must be visible in the trace, not just
 * swallowed into an HTTP 4xx/5xx with no trace-level signal of where it
 * happened. Ends the span in a `finally` so a thrown/rejected `fn` can
 * never leak an unclosed span.
 *
 * Safe to call unconditionally, including from every existing test file:
 * when no SDK has been started in this process (true for every test run —
 * tests build the app directly via buildApp()/createTestApp(), never
 * through an app's src/instrument.ts bootstrap), `trace.getTracer()`
 * returns a no-op tracer. This still runs `fn` correctly; it just
 * doesn't record or export anything.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
