import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { env } from "../../env.js";
import { ValidationError } from "../../errors.js";
import { login, logout, refresh, register } from "./service.js";
import { loginSchema, registerSchema } from "./schemas.js";

const REFRESH_COOKIE = "cm_refresh_token";

const refreshCookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/auth",
  maxAge: 60 * 60 * 24 * 7,
};

// Brute-force baseline for credential endpoints, ahead of Phase 4's full
// distributed rate limiter — deliberately much tighter than the global
// default registered in app.ts.
const authRateLimit = { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } };

export default async function authRoutes(fastify: FastifyInstance) {
  fastify.post("/auth/register", authRateLimit, async (request, reply) => {
    let input;
    try {
      input = registerSchema.parse(request.body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError(err.issues[0]?.message ?? "Invalid request");
      }
      throw err;
    }

    const result = await register({ db: fastify.db, redis: fastify.redis }, input);
    reply.code(201);
    return { orgId: result.orgId, userId: result.userId };
  });

  fastify.post("/auth/login", authRateLimit, async (request, reply) => {
    let input;
    try {
      input = loginSchema.parse(request.body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError(err.issues[0]?.message ?? "Invalid request");
      }
      throw err;
    }

    const result = await login({ db: fastify.db, redis: fastify.redis }, input);
    reply.setCookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions);
    return { accessToken: result.accessToken, user: result.user };
  });

  fastify.post("/auth/refresh", async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    if (!token) {
      reply.code(401);
      return { error: "Missing refresh token" };
    }

    const result = await refresh({ db: fastify.db, redis: fastify.redis }, token);
    reply.setCookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions);
    return { accessToken: result.accessToken };
  });

  fastify.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    if (token) {
      await logout({ db: fastify.db, redis: fastify.redis }, token);
    }
    reply.clearCookie(REFRESH_COOKIE, { path: "/auth" });
    reply.code(204);
  });
}
