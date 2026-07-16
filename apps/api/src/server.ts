import { buildApp } from "./app.js";
import { env } from "./env.js";

const app = await buildApp();

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// In production this runs behind an orchestrator (k8s, ECS, ...) that sends
// SIGTERM before killing the process — app.close() lets Fastify's onClose
// hooks (db.$disconnect, redis.disconnect) run and in-flight requests
// finish, instead of dropping connections mid-request.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, "shutting down");
    app.close().then(
      () => process.exit(0),
      (err) => {
        app.log.error(err, "error during shutdown");
        process.exit(1);
      },
    );
  });
}
