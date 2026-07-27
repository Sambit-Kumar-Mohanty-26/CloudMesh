import { disconnectAll, getAppPrisma } from "@cloudmesh/db";
import { createJobWorker } from "@cloudmesh/jobs";
import { Redis } from "ioredis";
import { env } from "./env.js";
import { buildJobRegistry } from "./modules/jobs/handlers.js";
import { buildEmbeddingProvider, buildRegistry } from "./providers/index.js";

/**
 * Worker process — deliberately a SEPARATE entry point from server.ts.
 *
 * This is what "workers scale horizontally" means concretely: run N of
 * these against the same Redis and they share the queue, without adding
 * HTTP capacity you don't need. It also means a job that pins a CPU or
 * leaks memory takes down a worker, not the API serving every other
 * tenant's chat traffic.
 *
 * Connects as the RLS-bound app role (getAppPrisma), the same as the HTTP
 * path — never the migration superuser. Each job's org scoping is applied
 * per-job inside the worker (see packages/jobs/src/queue.ts).
 */
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const prisma = getAppPrisma();

const registry = buildJobRegistry(buildEmbeddingProvider(env), buildRegistry(env, redis));

const worker = createJobWorker(redis, registry, {
  concurrency: env.JOB_WORKER_CONCURRENCY,
  lockDurationMs: env.JOB_LOCK_DURATION_MS,
  db: prisma,
  onError: (err) => {
    console.error("[worker] error", err instanceof Error ? err.name : "unknown");
  },
});

// console.warn, not .log: the repo's eslint config allows only error/warn
// (see the no-console rule). This is a startup banner, the worker's
// equivalent of Fastify's own listen log — it has no pino instance, since
// the logger is created by buildApp() and this process never builds an app.
console.warn(`[worker] listening on queue, concurrency=${env.JOB_WORKER_CONCURRENCY}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    // worker.close() waits for in-flight jobs to finish rather than killing
    // them mid-execution — an interrupted job would be retried from scratch
    // and, for anything non-idempotent, duplicated.
    worker
      .close()
      .then(() => redis.quit())
      .then(() => disconnectAll())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          console.error(
            "[worker] error during shutdown",
            err instanceof Error ? err.name : "unknown",
          );
          process.exit(1);
        },
      );
  });
}
