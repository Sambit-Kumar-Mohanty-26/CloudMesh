import { resolveApiKey } from "@cloudmesh/auth";
import { getJob, jobProgressChannel } from "@cloudmesh/jobs";
import type { FastifyInstance } from "fastify";

/**
 * Design doc: `Client → WebSocket /ws/jobs/{job_id}`, worker publishes to
 * Redis, server broadcasts to the client.
 *
 * Auth is enforced here explicitly rather than by the API-key preHandler on
 * the HTTP routes: this route is registered outside that plugin scope, and
 * an unauthenticated progress stream would leak a tenant's job state to
 * anyone who can guess a UUID. Two distinct checks, both required:
 *
 *   1. a valid API key (401 otherwise), and
 *   2. that key's org actually owns this job (closed as 404, matching the
 *      HTTP route so a cross-tenant probe can't distinguish "not yours"
 *      from "doesn't exist").
 *
 * Browsers can't set an Authorization header on a WebSocket handshake, so
 * the key may also arrive as `?api_key=`. That's a real trade-off: query
 * strings land in access logs and proxy history in a way headers don't.
 * It's supported because the alternative (a separate ticket-exchange
 * endpoint) is more surface than this phase needs — but the header is
 * preferred and checked first.
 */
export default async function jobWsRoutes(fastify: FastifyInstance) {
  fastify.get("/ws/jobs/:id", { websocket: true }, async (socket, request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { api_key?: string };

    const header = request.headers.authorization;
    const rawKey = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : query.api_key;

    if (!rawKey) {
      socket.close(4401, "Unauthorized");
      return;
    }

    const ctx = await resolveApiKey(fastify.db, fastify.redis, rawKey).catch(() => undefined);
    if (!ctx) {
      socket.close(4401, "Unauthorized");
      return;
    }

    // Ownership check — the whole reason this can't just trust the job id.
    const job = await getJob(fastify.db, ctx.orgId, id);
    if (!job) {
      socket.close(4404, "Job not found");
      return;
    }

    // Send current state immediately so a client attaching to an
    // already-running (or already-finished) job isn't left waiting for a
    // pub/sub message that may never come again.
    socket.send(
      JSON.stringify({
        jobId: job.id,
        progress: job.progress,
        status: job.status,
        error: job.error,
      }),
    );
    if (job.status === "COMPLETED" || job.status === "DEAD_LETTER") {
      socket.close(1000, "Job already finished");
      return;
    }

    // Its own connection: a Redis client in subscriber mode can't run
    // ordinary commands, so subscribing on the shared client would break
    // every other consumer of it (rate limiter, cache, circuit breaker).
    const subscriber = fastify.redis.duplicate();
    const channel = jobProgressChannel(id);

    subscriber.on("message", (_channel, message) => {
      socket.send(message);
      try {
        const event = JSON.parse(message) as { status?: string };
        if (event.status === "COMPLETED" || event.status === "DEAD_LETTER") {
          socket.close(1000, "Job finished");
        }
      } catch {
        // A malformed message must not kill the stream; it's already been
        // forwarded verbatim above.
      }
    });

    await subscriber.subscribe(channel);

    // Always tear the subscriber down — one leaked Redis connection per
    // dropped WebSocket would exhaust the connection limit under any real
    // client churn.
    socket.on("close", () => {
      void subscriber.quit().catch(() => undefined);
    });
    socket.on("error", () => {
      void subscriber.quit().catch(() => undefined);
    });
  });
}
