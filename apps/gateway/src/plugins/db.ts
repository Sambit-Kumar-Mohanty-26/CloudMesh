import { getAppPrisma, type PrismaClient } from "@cloudmesh/db";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    db: PrismaClient;
  }
}

// getAppPrisma() is a process-wide singleton (one real connection pool per
// process, by design). This plugin must NOT disconnect it on this
// instance's close — a Fastify instance closing doesn't mean the process
// is shutting down, and other instances (or, in tests, other app builds in
// the same process) may still be using the same shared client. The actual
// process-shutdown disconnect belongs to server.ts, via disconnectAll().
export default fp(async function dbPlugin(fastify: FastifyInstance) {
  fastify.decorate("db", getAppPrisma());
});
