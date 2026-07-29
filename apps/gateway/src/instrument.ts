import { startTelemetry } from "@cloudmesh/telemetry";

/**
 * The gateway's real entry point, for every process (server/worker/
 * consumers/webhookWorker — see package.json's scripts). Not server.ts
 * itself: ES module static imports are hoisted and fully evaluated before
 * any code in the importing module's own body runs, so calling
 * `startTelemetry()` as the first line of server.ts would still be too
 * late — `import { getAppPrisma } from "@cloudmesh/db"` (which pulls in
 * `pg`) et al. would already have loaded by then, unpatched. Starting
 * telemetry here, then dynamically importing the real entry only after it
 * returns, guarantees the SDK's instrumentation hooks are registered
 * before any instrumented module is ever imported. See
 * @cloudmesh/telemetry's tracing.ts for the full explanation.
 *
 * The target file is a CLI arg, not an env var — `worker=x npm run worker`
 * fails outright on native Windows cmd.exe (no inline env-var-prefix
 * syntax), and this repo runs on Windows.
 */
startTelemetry(process.env.OTEL_SERVICE_NAME ?? "cloudmesh-gateway");

const entry = process.argv[2] ?? "server";
await import(`./${entry}.js`);
