import { liveStatsChannel } from "@cloudmesh/metrics";
import type { FastifyInstance } from "fastify";
import { verifyAccessToken } from "../../lib/jwt.js";

/**
 * Design doc: `Live request counter -> WS /ws/live-stats -> Redis SUBSCRIBE
 * analytics:{org} -> server pushes {rps, p99, errors} every 5s`. This route
 * only relays — apps/gateway's server.ts is the sole publisher (see its
 * lib/orgLiveStats.ts), the same split as Phase 9's job-progress WS
 * (worker publishes, apps/gateway's own WS route relays).
 *
 * Auth mirrors Phase 9's `/ws/jobs/:id` exactly, JWT instead of API key:
 * browsers can't set an Authorization header on a WebSocket handshake, so
 * the access token may also arrive as `?token=` — the same query-string
 * trade-off documented there (access logs/proxy history vs. a dedicated
 * ticket-exchange endpoint this phase's scope doesn't call for). The
 * header is checked first and preferred when present.
 */
export default async function liveStatsWsRoutes(fastify: FastifyInstance) {
  fastify.get("/ws/live-stats", { websocket: true }, (socket, request) => {
    const query = request.query as { token?: string };
    const header = request.headers.authorization;
    const rawToken = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : query.token;

    if (!rawToken) {
      socket.close(4401, "Unauthorized");
      return;
    }

    let orgId: string;
    try {
      orgId = verifyAccessToken(rawToken).orgId;
    } catch {
      socket.close(4401, "Unauthorized");
      return;
    }

    // Its own connection: a Redis client in subscriber mode can't run
    // ordinary commands, so subscribing on the shared client would break
    // every other consumer of it — same reason as Phase 9's job-progress WS.
    const subscriber = fastify.redis.duplicate();
    const channel = liveStatsChannel(orgId);

    subscriber.on("message", (_channel, message) => {
      socket.send(message);
    });

    subscriber.subscribe(channel).catch((err: unknown) => {
      fastify.log.error(err, "failed to subscribe to live stats channel");
      socket.close(1011, "Subscription failed");
    });

    socket.on("close", () => {
      void subscriber.quit().catch(() => undefined);
    });
    socket.on("error", () => {
      void subscriber.quit().catch(() => undefined);
    });
  });
}
