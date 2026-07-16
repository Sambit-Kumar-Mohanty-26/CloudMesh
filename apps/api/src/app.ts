import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { env } from "./env.js";
import { AppError } from "./errors.js";
import dbPlugin from "./plugins/db.js";
import redisPlugin from "./plugins/redis.js";
import authRoutes from "./modules/auth/routes.js";
import apiKeyRoutes from "./modules/apiKeys/routes.js";
import whoamiRoute from "./modules/apiKeys/whoamiRoute.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : true,
  });

  await app.register(dbPlugin);
  await app.register(redisPlugin);
  await app.register(cookie);

  // Global baseline; auth endpoints below override with a much tighter
  // limit, since credential endpoints are a brute-force target from day
  // one — Phase 4's full distributed rate limiter replaces this later, it
  // doesn't wait for it.
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    redis: app.redis,
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      reply.code(err.statusCode).send({ error: err.message, code: err.code });
      return;
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      reply.code(429).send({ error: "Too many requests", code: "RATE_LIMITED" });
      return;
    }
    // Fastify and its plugins (JSON body parsing, the 1MB default body
    // limit, etc.) throw errors with their own valid 4xx statusCode — a
    // malformed request body is a client mistake, not a server failure,
    // and must not be flattened into a 500.
    const frameworkStatus = (err as { statusCode?: number }).statusCode;
    if (typeof frameworkStatus === "number" && frameworkStatus >= 400 && frameworkStatus < 500) {
      reply.code(frameworkStatus).send({ error: (err as Error).message, code: "BAD_REQUEST" });
      return;
    }
    request.log.error(err);
    reply.code(500).send({ error: "Internal server error", code: "INTERNAL_ERROR" });
  });

  await app.register(authRoutes);
  await app.register(apiKeyRoutes);
  await app.register(whoamiRoute);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
