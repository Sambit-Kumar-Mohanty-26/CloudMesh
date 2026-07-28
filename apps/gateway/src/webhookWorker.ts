import { disconnectAll, getAppPrisma } from "@cloudmesh/db";
import { createWebhookWorker } from "@cloudmesh/webhooks";
import { Redis } from "ioredis";
import { env } from "./env.js";

/**
 * Webhook delivery worker — a fourth entry point alongside server.ts (HTTP),
 * worker.ts (Phase 9 job queue), and consumers.ts (NATS event subscribers).
 *
 * consumers.ts's webhook dispatch subscriber only ENQUEUES a BullMQ job per
 * (endpoint, event) pair — see dispatchWebhookEvent in @cloudmesh/webhooks.
 * This process is what actually re-checks the target (DNS can rebind between
 * registration and delivery, so the SSRF guard runs again here, not just at
 * registration time), signs the payload, POSTs it, and records the outcome.
 *
 * Same rationale as worker.ts for being separate from the HTTP server: a
 * webhook endpoint that hangs or a delivery burst that pins a CPU takes down
 * this process, not the API serving every tenant's chat traffic. Scales
 * horizontally the same way — run N of these against the same Redis.
 */
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const prisma = getAppPrisma();

const worker = createWebhookWorker(redis, {
  concurrency: env.JOB_WORKER_CONCURRENCY,
  db: prisma,
  onError: (err) => {
    console.error("[webhookWorker] error", err instanceof Error ? err.name : "unknown");
  },
});

console.warn(
  `[webhookWorker] listening on webhook queue, concurrency=${env.JOB_WORKER_CONCURRENCY}`,
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    // Same drain-not-kill shutdown as worker.ts: an interrupted delivery
    // attempt would be retried from scratch on the next process anyway,
    // so let in-flight ones finish rather than cutting them off mid-POST.
    worker
      .close()
      .then(() => redis.quit())
      .then(() => disconnectAll())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          console.error(
            "[webhookWorker] error during shutdown",
            err instanceof Error ? err.name : "unknown",
          );
          process.exit(1);
        },
      );
  });
}
