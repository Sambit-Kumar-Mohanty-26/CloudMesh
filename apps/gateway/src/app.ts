import Fastify, { type FastifyInstance } from "fastify";
import { env } from "./env.js";
import { AppError } from "./errors.js";
import chatRoutes from "./modules/chat/routes.js";
import dbPlugin from "./plugins/db.js";
import modelsPlugin from "./plugins/models.js";
import redisPlugin from "./plugins/redis.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : true,
  });

  await app.register(dbPlugin);
  await app.register(redisPlugin);
  await app.register(modelsPlugin);

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

  await app.register(chatRoutes);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
