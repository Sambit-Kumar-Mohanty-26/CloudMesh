import { getAppPrisma, type PrismaClient } from "@cloudmesh/db";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    db: PrismaClient;
  }
}

export default fp(async function dbPlugin(fastify: FastifyInstance) {
  const db = getAppPrisma();
  fastify.decorate("db", db);
  fastify.addHook("onClose", async () => {
    await db.$disconnect();
  });
});
