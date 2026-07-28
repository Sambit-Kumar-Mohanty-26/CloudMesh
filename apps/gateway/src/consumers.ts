import { disconnectAll, getAppPrisma } from "@cloudmesh/db";
import { connectEventBus, type Subscription } from "@cloudmesh/events";
import { createWebhookQueue } from "@cloudmesh/webhooks";
import { Redis } from "ioredis";
import { env } from "./env.js";
import { ResendAdapter } from "./providers/resend.js";
import {
  startAnalyticsSubscriber,
  startAuditSubscriber,
  startBillingSubscriber,
  startEmailSubscriber,
  startWebhookDispatchSubscriber,
} from "./modules/events/subscribers.js";

/**
 * Event consumer process — a third entry point alongside server.ts (HTTP)
 * and worker.ts (jobs). Phase 11 adds a fourth: webhookWorker.ts, the
 * separate process that actually drains and delivers the webhook queue
 * this file's dispatch subscriber only ENQUEUES to.
 *
 * All five subscribers run here rather than as five separate deployables.
 * They're independent NATS consumers with their own durables, so the
 * decoupling the design doc cares about (one subscriber failing or
 * lagging without affecting the others, each resuming from its own
 * position) is a property of the durable consumers, not the process
 * boundary. Splitting into five services is a deployment decision that
 * would quadruple connection/pool overhead for no isolation gain at this
 * scale.
 */
const natsUrl = env.NATS_URL;
if (!natsUrl) {
  console.error("[consumers] NATS_URL is required to run event consumers");
  process.exit(1);
}

const redis = new Redis(env.REDIS_URL);
const db = getAppPrisma();
const bus = await connectEventBus({ servers: natsUrl, name: "cloudmesh-consumers" });
const webhookQueue = createWebhookQueue(redis);
const resend = new ResendAdapter({
  apiKey: env.RESEND_API_KEY,
  baseUrl: env.RESEND_BASE_URL,
  fromEmail: env.RESEND_FROM_EMAIL,
});

const onError = (err: unknown) => {
  // Only the error's class name — event payloads can carry tenant data, and
  // a thrown Prisma/provider error can echo bound parameters in its message
  // (same rule as the semantic cache's catch block).
  console.error("[consumers] handler error", err instanceof Error ? err.name : "unknown");
};

const deps = { bus, db, redis, onError };

const subscriptions: Subscription[] = [
  await startAnalyticsSubscriber(deps),
  await startAuditSubscriber(deps),
  // No reportUsage supplied: the Stripe adapter lives in apps/api and this
  // environment has no Stripe credentials, so the billing consumer runs and
  // acks (keeping its durable position current) without reporting. Wiring
  // the real call is a one-line injection once a Stripe key exists.
  await startBillingSubscriber(deps),
  await startWebhookDispatchSubscriber({ ...deps, webhookQueue }),
  await startEmailSubscriber({
    ...deps,
    sendEmail: (input) =>
      resend
        .sendEmail(input)
        .catch((err: unknown) => onError(err)) // unconfigured/failed send never blocks the subscriber
        .then(() => undefined),
  }),
];

console.warn(`[consumers] ${subscriptions.length} subscribers running against ${natsUrl}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    // Stop consuming first, then drain the connection — otherwise in-flight
    // messages get redelivered later even though they were fully handled.
    Promise.all(subscriptions.map((s) => s.stop()))
      .then(() => bus.close())
      .then(() => webhookQueue.close())
      .then(() => redis.quit())
      .then(() => disconnectAll())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          console.error(
            "[consumers] error during shutdown",
            err instanceof Error ? err.name : "unknown",
          );
          process.exit(1);
        },
      );
  });
}
