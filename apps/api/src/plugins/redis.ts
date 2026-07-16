import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { env } from "../env.js";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

export default fp(async function redisPlugin(fastify: FastifyInstance) {
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true });
  await redis.connect();
  fastify.decorate("redis", redis);
  fastify.addHook("onClose", async () => {
    redis.disconnect();
  });
});
