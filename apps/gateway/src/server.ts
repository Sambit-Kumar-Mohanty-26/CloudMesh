import { disconnectAll, getAppPrisma } from "@cloudmesh/db";
import { connectEventBus, type EventBus } from "@cloudmesh/events";
import { LogEventPublisher, startOutboxPoller, type EventPublisher } from "@cloudmesh/outbox";
import { buildApp } from "./app.js";
import { env } from "./env.js";
import { NatsEventPublisher } from "./lib/natsPublisher.js";

const app = await buildApp();

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Phase 10: the outbox drains onto real NATS JetStream. Falling back to the
// log publisher when NATS_URL is unset keeps the gateway bootable with no
// broker running — but it's a dev convenience, not a production mode:
// events still accumulate in the outbox table, they just aren't delivered.
let eventBus: EventBus | undefined;
let publisher: EventPublisher;
if (env.NATS_URL) {
  eventBus = await connectEventBus({ servers: env.NATS_URL, name: "cloudmesh-gateway" });
  publisher = new NatsEventPublisher(eventBus);
  app.log.info({ servers: env.NATS_URL }, "event bus connected");
} else {
  publisher = new LogEventPublisher((msg, fields) => app.log.info(fields, msg));
  app.log.warn("NATS_URL not set — outbox events will be logged, not published");
}

const outboxPoller = startOutboxPoller(
  getAppPrisma(),
  publisher,
  env.OUTBOX_POLL_INTERVAL_MS,
  (err) => app.log.error(err, "outbox poll failed"),
);

// See apps/api/src/server.ts for why disconnectAll() happens here, after
// app.close(), rather than in plugins/db.ts's onClose hook.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, "shutting down");
    outboxPoller.stop();
    app
      .close()
      // drain() (inside close) lets in-flight publishes finish rather than
      // dropping them — the poller has already stopped, so this is bounded.
      .then(() => eventBus?.close())
      .then(() => disconnectAll())
      .then(
        () => process.exit(0),
        (err) => {
          app.log.error(err, "error during shutdown");
          process.exit(1);
        },
      );
  });
}
