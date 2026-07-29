import { context, trace } from "@opentelemetry/api";

export interface TraceContext {
  trace_id: string;
  span_id: string;
}

/**
 * The active span's trace/span ids, for correlating a log line with the
 * trace it happened inside (Pino's `mixin` option in both apps' app.ts
 * calls this on every log line). Undefined when there's no active span —
 * no SDK started in this process (every test run), or genuinely no span
 * in scope at the call site.
 */
export function getTraceContext(): TraceContext | undefined {
  const span = trace.getSpan(context.active());
  if (!span) return undefined;
  const spanContext = span.spanContext();
  if (!spanContext.traceId || !spanContext.spanId) return undefined;
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}
