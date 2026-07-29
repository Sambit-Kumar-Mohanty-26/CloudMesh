import { describe, expect, it } from "vitest";
import { getTraceContext } from "../src/context.js";
import { withSpan } from "../src/spans.js";

/**
 * Deliberately never calls `trace.setGlobalTracerProvider` — this is the
 * real-world state of every existing app.ts/route test file in the repo,
 * since tests build the app via buildApp()/createTestApp() directly, never
 * through an app's src/instrument.ts bootstrap (see tracing.ts's doc
 * comment). `@opentelemetry/api`'s tracer falls back to a no-op
 * implementation with no global provider registered, so both helpers must
 * behave correctly — running `fn` and returning normally — with zero
 * tracing infrastructure present.
 */
describe("telemetry helpers with no tracer provider registered", () => {
  it("withSpan still runs fn and returns its result", async () => {
    const result = await withSpan("auth", { orgId: "org_1" }, async () => "ran");
    expect(result).toBe("ran");
  });

  it("withSpan still re-throws fn's error", async () => {
    await expect(
      withSpan("billing", {}, async () => {
        throw new Error("no budget");
      }),
    ).rejects.toThrow("no budget");
  });

  it("getTraceContext returns undefined", () => {
    expect(getTraceContext()).toBeUndefined();
  });
});
