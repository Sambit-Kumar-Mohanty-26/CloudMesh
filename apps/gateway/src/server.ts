import { getCircuitState } from "@cloudmesh/circuit-breaker";
import { disconnectAll, getAppPrisma } from "@cloudmesh/db";
import { connectEventBus, type EventBus } from "@cloudmesh/events";
import { setCircuitBreakerState } from "@cloudmesh/metrics";
import { LogEventPublisher, startOutboxPoller, type EventPublisher } from "@cloudmesh/outbox";
import { buildApp } from "./app.js";
import { env } from "./env.js";
import { NatsEventPublisher } from "./lib/natsPublisher.js";
import { getActiveOrgIds, getOrgLiveStats, liveStatsChannel } from "./lib/orgLiveStats.js";

const app = await buildApp();

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Phase 10: the outbox drains onto real NATS JetStream. Falling back to the
// log publisher when NATS_URL is unset keeps the gateway bootable with no
// broker running — but it's a dev convenience, not a production mode:
// events still accumulate in the outbox table, they just aren't delivered.
let eventBus: EventBus | undefined;
let publisher: EventPublisher;
if (env.NATS_URL) {
  eventBus = await connectEventBus({ servers: env.NATS_URL, name: "cloudmesh-gateway" });
  publisher = new NatsEventPublisher(eventBus);
  app.log.info({ servers: env.NATS_URL }, "event bus connected");
} else {
  publisher = new LogEventPublisher((msg, fields) => app.log.info(fields, msg));
  app.log.warn("NATS_URL not set — outbox events will be logged, not published");
}

const outboxPoller = startOutboxPoller(
  getAppPrisma(),
  publisher,
  env.OUTBOX_POLL_INTERVAL_MS,
  (err) => app.log.error(err, "outbox poll failed"),
);

// cloudmesh_circuit_breaker_state — a periodic poll, not purely reactive
// updates from request-path code, because a circuit can transition (e.g.
// half-open -> closed after a successful probe from a DIFFERENT request,
// or open -> half-open purely from its own TTL expiring in Redis) with no
// new request ever touching the specific call site that would otherwise
// update the gauge. Every known provider, not just ones with recent
// traffic — an idle-but-open circuit should still show as open, not
// silently vanish from the dashboard.
const circuitMetricsPoll = setInterval(() => {
  const providers = app.models.listProviderNames();
  Promise.all(
    providers.map(async (provider) => {
      const state = await getCircuitState(app.redis, provider);
      setCircuitBreakerState(provider, state);
    }),
  ).catch((err: unknown) => app.log.error(err, "circuit metrics poll failed"));
}, env.CIRCUIT_METRICS_POLL_INTERVAL_MS);
circuitMetricsPoll.unref();

// Dashboard live stats — publishes each recently-active org's {rps, p99,
// errors} onto `analytics:{orgId}`, which apps/api's WS /ws/live-stats
// subscribes to and relays. Only orgs with at least one sample in the last
// poll's active-orgs set get a publish — no subscribers means no waste,
// and an org that goes quiet naturally stops updating (still returns
// all-zeros on the next request, not stale nonzero data).
const liveStatsPoll = setInterval(() => {
  getActiveOrgIds(app.redis)
    .then((orgIds) =>
      Promise.all(
        orgIds.map(async (orgId) => {
          const stats = await getOrgLiveStats(app.redis, orgId);
          await app.redis.publish(liveStatsChannel(orgId), JSON.stringify(stats));
        }),
      ),
    )
    .catch((err: unknown) => app.log.error(err, "live stats publish failed"));
}, env.LIVE_STATS_PUBLISH_INTERVAL_MS);
liveStatsPoll.unref();

// See apps/api/src/server.ts for why disconnectAll() happens here, after
// app.close(), rather than in plugins/db.ts's onClose hook.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, "shutting down");
    outboxPoller.stop();
    clearInterval(circuitMetricsPoll);
    app
      .close()
      // drain() (inside close) lets in-flight publishes finish rather than
      // dropping them — the poller has already stopped, so this is bounded.
      .then(() => eventBus?.close())
      .then(() => disconnectAll())
      .then(
        () => process.exit(0),
        (err) => {
          app.log.error(err, "error during shutdown");
          process.exit(1);
        },
      );
  });
}
