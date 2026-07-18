import { disconnectAll } from "@cloudmesh/db";
import { buildApp } from "./app.js";
import { env } from "./env.js";

const app = await buildApp();

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// See apps/api/src/server.ts for why disconnectAll() happens here, after
// app.close(), rather than in plugins/db.ts's onClose hook.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, "shutting down");
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
