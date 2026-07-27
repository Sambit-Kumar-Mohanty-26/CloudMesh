import { createJobQueue, JobRegistry } from "@cloudmesh/jobs";
import type { Queue } from "bullmq";
import type { JobData } from "@cloudmesh/jobs";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { buildJobRegistry } from "../modules/jobs/handlers.js";

declare module "fastify" {
  interface FastifyInstance {
    jobQueue: Queue<JobData>;
    jobRegistry: JobRegistry;
  }
}

/**
 * The API side only needs to ENQUEUE — the worker that drains this queue is
 * a separate process (src/worker.ts), which is what makes workers scale
 * horizontally per the design doc. The registry is decorated here too so
 * routes can reject an unknown job type (and validate its payload) before
 * anything is enqueued.
 *
 * Unlike getAppPrisma()/getRedis(), the BullMQ Queue owns its own duplicated
 * Redis connection, so it IS this plugin's to close — closing it on
 * onClose is correct and doesn't affect the shared client. (Contrast
 * plugins/db.ts, which must NOT disconnect the process-wide singleton.)
 */
export default fp(async function jobsPlugin(fastify: FastifyInstance) {
  const queue = createJobQueue(fastify.redis);
  const registry: JobRegistry = buildJobRegistry(fastify.embeddings, fastify.models);

  fastify.decorate("jobQueue", queue);
  fastify.decorate("jobRegistry", registry);

  fastify.addHook("onClose", async () => {
    await queue.close();
  });
});
