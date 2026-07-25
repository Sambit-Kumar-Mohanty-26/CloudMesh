import { disconnectAll, getAppPrisma } from "@cloudmesh/db";
import { buildApp } from "./app.js";
import { env } from "./env.js";
import { LogEventPublisher, startOutboxPoller } from "./lib/outbox.js";

const app = await buildApp();

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// LogEventPublisher is a placeholder — NATS JetStream (the real target) is
// Phase 10. The poller loop and "mark published on success" bookkeeping are
// real today; only what "publish" actually does will change later.
const outboxPoller = startOutboxPoller(
  getAppPrisma(),
  new LogEventPublisher((msg, fields) => app.log.info(fields, msg)),
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
