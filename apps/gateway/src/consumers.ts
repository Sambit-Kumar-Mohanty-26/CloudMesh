import { disconnectAll, getAppPrisma } from "@cloudmesh/db";
import { connectEventBus, type Subscription } from "@cloudmesh/events";
import { Redis } from "ioredis";
import { env } from "./env.js";
import {
  startAnalyticsSubscriber,
  startAuditSubscriber,
  startBillingSubscriber,
  startNotificationSubscriber,
} from "./modules/events/subscribers.js";

/**
 * Event consumer process — a third entry point alongside server.ts (HTTP)
 * and worker.ts (jobs).
 *
 * All four subscribers run here rather than as four separate deployables.
 * They're independent NATS consumers with their own durables, so the
 * decoupling the design doc cares about (one subscriber failing doesn't
 * affect the others, each resumes from its own position) is a property of
 * the durable consumers, not of the process boundary. Splitting them into
 * four services is a deployment decision this project doesn't need yet, and
 * would quadruple the connection/DB-pool overhead for no isolation gain at
 * this scale.
 */
// Unlike the gateway (which degrades to a log publisher), a consumer
// process with no bus to consume from has nothing to do — failing loudly at
// startup beats running as a silent no-op that looks healthy.
const natsUrl = env.NATS_URL;
if (!natsUrl) {
  console.error("[consumers] NATS_URL is required to run event consumers");
  process.exit(1);
}

const redis = new Redis(env.REDIS_URL);
const db = getAppPrisma();
const bus = await connectEventBus({ servers: natsUrl, name: "cloudmesh-consumers" });

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
  await startNotificationSubscriber({
    ...deps,
    notify: async (event) => {
      // Delivery (signed webhooks / email) is Phase 11, including the SSRF
      // validation org-supplied URLs require. Logging the decision keeps
      // this consumer real without building half a delivery system.
      console.warn(`[consumers] notification: ${event.kind} for org ${event.orgId}`);
    },
  }),
];

console.warn(`[consumers] ${subscriptions.length} subscribers running against ${natsUrl}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    // Stop consuming first, then drain the connection — otherwise in-flight
    // messages get redelivered later even though they were fully handled.
    Promise.all(subscriptions.map((s) => s.stop()))
      .then(() => bus.close())
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
