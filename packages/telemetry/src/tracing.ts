import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/**
 * Starts the OTel Node SDK for one process. MUST be imported and invoked
 * from a dedicated bootstrap file (each app's src/instrument.ts), loaded
 * before the real entry point (server.ts/worker.ts/...) — not as the first
 * line of that entry point itself. ES module static imports are hoisted
 * and fully evaluated before any code in the importing module's own body
 * runs, so by the time a call placed at the top of server.ts would
 * execute, `import { getAppPrisma } from "@cloudmesh/db"` (which pulls in
 * `pg`) has already loaded — too late for auto-instrumentation to patch
 * it. A separate bootstrap file, dynamically importing the real entry
 * point only after this returns, is what makes the ordering correct.
 *
 * The OTLP exporter reads `OTEL_EXPORTER_OTLP_ENDPOINT` (or the more
 * specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) itself per the OTel spec's
 * standard env vars, defaulting to `http://localhost:4318/v1/traces` —
 * exactly Jaeger's OTLP HTTP receiver in docker-compose.yml. No live
 * collector required to boot: an unreachable endpoint just logs export
 * errors periodically, the same "point at a real endpoint via env var, or
 * don't" pattern as NATS_URL/RESEND_API_KEY elsewhere in this codebase.
 *
 * **Hand-picked instrumentations, not `@opentelemetry/auto-instrumentations-
 * node`'s kitchen sink, on purpose.** That meta-package bundles ~15
 * framework/driver instrumentations (amqplib, aws-sdk, express, mongoose,
 * mysql2, restify, koa, hapi, ...) this codebase doesn't use, plus cloud
 * resource-detector packages (`@opentelemetry/resource-detector-{aws,gcp,
 * azure,...}`) that dragged in a real, high-severity transitive
 * vulnerability chain (`gcp-metadata` -> `gaxios` -> `rimraf` -> `glob` ->
 * a vulnerable `brace-expansion`, GHSA-mh99-v99m-4gvg) purely to detect
 * cloud metadata this deployment never needs. Three targeted
 * instrumentations cover every I/O path that actually exists here: `http`
 * (Fastify sits directly on Node's http server), `undici` (every provider
 * adapter and outbound webhook/Resend/Stripe call in this codebase uses
 * `fetch()`, which Node backs with undici), and `ioredis` (the rate
 * limiter, circuit breaker, cache, and dedup all go through it). **No `pg`
 * instrumentation** — `packages/db` uses Prisma's default binary query
 * engine, not the `pg` npm driver (no `@prisma/adapter-pg`, no `pg` in its
 * dependencies), so `@opentelemetry/instrumentation-pg` would attach to
 * nothing.
 */
export function startTelemetry(serviceName: string): NodeSDK {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation(),
      new UndiciInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });
  sdk.start();
  return sdk;
}
