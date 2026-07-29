import { startTelemetry } from "@cloudmesh/telemetry";

/**
 * apps/api's real entry point, replacing server.ts directly in
 * package.json's dev/start scripts — not server.ts itself. See
 * apps/gateway/src/instrument.ts's doc comment (identical reasoning): ES
 * module static imports are hoisted and fully evaluated before any code in
 * the importing module's own body runs, so calling `startTelemetry()` as
 * the first line of server.ts would still be too late for
 * auto-instrumentation to patch what server.ts's own imports (`pg` via
 * @cloudmesh/db, ioredis, ...) already pulled in.
 */
startTelemetry(process.env.OTEL_SERVICE_NAME ?? "cloudmesh-api");

await import("./server.js");
