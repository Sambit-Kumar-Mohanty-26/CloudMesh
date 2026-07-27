import {
  createJob,
  getJob,
  listJobs,
  replayJob,
  JobNotReplayableError,
  UnknownJobTypeError,
} from "@cloudmesh/jobs";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { NotFoundError, ValidationError } from "../../errors.js";
import { requireApiKey } from "../../middleware/requireApiKey.js";
import { requireRateLimit } from "../../middleware/requireRateLimit.js";
import { createJobSchema, listJobsQuerySchema } from "./schemas.js";

// Rate limiting follows the same rule as POST /v1/chat vs GET /v1/models
// (see CLAUDE.md): the routes that cause real provider spend are limited,
// cheap reads are not. Submitting a job enqueues work a whole worker pool
// will spend provider budget on, and replay re-enqueues exactly that same
// work from the DLQ — both are limited against the key's own rate_limit_rpm
// via the existing token bucket. Polling job status is an indexed
// single-row read and is deliberately left unlimited, the same call the
// design doc expects clients to poll.
const enqueueGuard = { preHandler: requireRateLimit };

/** The API shape the design doc specifies: `{ status, progress, result }`,
 *  plus the fields a client needs to poll and debug. Deliberately never
 *  includes another org's data — every read below is tenant-scoped. */
function serializeJob(job: {
  id: string;
  type: string;
  status: string;
  priority: number;
  progress: number;
  payload: unknown;
  result: unknown;
  error: string | null;
  attempts: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}) {
  return {
    job_id: job.id,
    type: job.type,
    status: job.status,
    priority: job.priority,
    progress: job.progress,
    payload: job.payload,
    result: job.result,
    error: job.error,
    attempts: job.attempts,
    created_at: job.createdAt,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
  };
}

export default async function jobRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", requireApiKey);

  fastify.post("/v1/jobs", enqueueGuard, async (request, reply) => {
    let input;
    try {
      input = createJobSchema.parse(request.body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError(err.issues[0]?.message ?? "Invalid request");
      }
      throw err;
    }

    const orgId = request.apiKeyCtx!.orgId;

    // Validate BOTH the type and its payload before enqueueing. A job that
    // can never succeed must fail at submission with a 400, not burn three
    // worker attempts and land in the DLQ as if it were an outage.
    let handler;
    try {
      handler = request.server.jobRegistry.get(input.type);
    } catch (err) {
      if (err instanceof UnknownJobTypeError) {
        throw new ValidationError(
          `Unknown job type: ${input.type}. Known types: ${request.server.jobRegistry.types().join(", ")}`,
        );
      }
      throw err;
    }
    // Throws ValidationError (-> 400) on a malformed payload.
    handler.parsePayload(input.payload as never);

    const job = await createJob(request.server.db, request.server.jobQueue, {
      orgId,
      type: input.type,
      payload: input.payload,
      priority: input.priority,
    });

    reply.code(202); // accepted for async processing, not completed
    return { job_id: job.id, status: job.status, type: job.type, priority: job.priority };
  });

  fastify.get("/v1/jobs", async (request) => {
    const orgId = request.apiKeyCtx!.orgId;
    let query;
    try {
      query = listJobsQuerySchema.parse(request.query);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError(err.issues[0]?.message ?? "Invalid query");
      }
      throw err;
    }

    const jobs = await listJobs(request.server.db, orgId, {
      status: query.status,
      limit: query.limit,
    });
    return { jobs: jobs.map(serializeJob) };
  });

  fastify.get("/v1/jobs/:id", async (request) => {
    const orgId = request.apiKeyCtx!.orgId;
    const { id } = request.params as { id: string };

    const job = await getJob(request.server.db, orgId, id);
    // RLS makes another org's job invisible, so a cross-tenant id lands
    // here identically to a nonexistent one — a 404 either way, never
    // confirming that someone else's job id exists.
    if (!job) throw new NotFoundError("Job not found");
    return serializeJob(job);
  });

  fastify.post("/v1/jobs/:id/replay", enqueueGuard, async (request, reply) => {
    const orgId = request.apiKeyCtx!.orgId;
    const { id } = request.params as { id: string };

    const job = await getJob(request.server.db, orgId, id);
    if (!job) throw new NotFoundError("Job not found");

    try {
      await replayJob(request.server.db, request.server.jobQueue, orgId, id);
    } catch (err) {
      if (err instanceof JobNotReplayableError) {
        throw new ValidationError(err.message);
      }
      throw err;
    }

    reply.code(202);
    return { job_id: id, status: "QUEUED" };
  });
}
