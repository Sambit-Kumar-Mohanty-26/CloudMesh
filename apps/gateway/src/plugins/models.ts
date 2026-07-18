import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { env } from "../env.js";
import { buildRegistry, type ModelRegistry } from "../providers/index.js";

declare module "fastify" {
  interface FastifyInstance {
    models: ModelRegistry;
  }
}

// Depends on fastify.redis existing — app.ts registers redisPlugin before
// this one, and that sequential `await app.register(...)` ordering is what
// actually guarantees it's ready (fastify-plugin's own `dependencies`
// option checks a plugin's inferred *name*, which didn't behave as
// expected here — don't reach for it without verifying the name matches).
export default fp(async function modelsPlugin(fastify: FastifyInstance) {
  fastify.decorate("models", buildRegistry(env, fastify.redis));
});
