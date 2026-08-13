import { registerMetricsRoute } from "@cloudmesh/metrics";
import { getTraceContext } from "@cloudmesh/telemetry";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { env } from "./env.js";
import { AppError } from "./errors.js";
import chatRoutes from "./modules/chat/routes.js";
import docsRoutes from "./modules/docs/routes.js";
import jobRoutes from "./modules/jobs/routes.js";
import jobWsRoutes from "./modules/jobs/wsRoutes.js";
import dbPlugin from "./plugins/db.js";
import embeddingsPlugin from "./plugins/embeddings.js";
import jobsPlugin from "./plugins/jobs.js";
import modelsPlugin from "./plugins/models.js";
import redisPlugin from "./plugins/redis.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Pino's `mixin` runs on every log call and merges its return value
    // into that line — this is Phase 12's log/trace correlation: any log
    // written from inside a request that has an active OTel span
    // automatically carries that span's trace_id/span_id, with zero
    // call-site changes anywhere else in the codebase. Returns `{}` (not
    // undefined) with no active span so the shape stays consistent rather
    // than sometimes having the fields and sometimes not.
    logger: env.NODE_ENV === "test" ? false : { mixin: () => getTraceContext() ?? {} },
  });

  await app.register(dbPlugin);
  await app.register(redisPlugin);
  await app.register(modelsPlugin);
  await app.register(embeddingsPlugin);
  // Must come after models + embeddings: the job registry's handlers are
  // built from both (see modules/jobs/handlers.ts).
  await app.register(jobsPlugin);
  await app.register(websocket);
  await app.register(registerMetricsRoute);

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      if (err.headers) reply.headers(err.headers);
      reply.code(err.statusCode).send({ error: err.message, code: err.code });
      return;
    }
    const frameworkStatus = (err as { statusCode?: number }).statusCode;
    if (typeof frameworkStatus === "number" && frameworkStatus >= 400 && frameworkStatus < 500) {
      reply.code(frameworkStatus).send({ error: (err as Error).message, code: "BAD_REQUEST" });
      return;
    }
    request.log.error(err);
    reply.code(500).send({ error: "Internal server error", code: "INTERNAL_ERROR" });
  });

  await app.register(docsRoutes);
  await app.register(chatRoutes);
  await app.register(jobRoutes);
  await app.register(jobWsRoutes);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
