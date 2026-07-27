import { randomUUID } from "node:crypto";
import { getAdminPrisma, resetDatabase, withTenant } from "@cloudmesh/db";
import {
  connectEventBus,
  EVENT_STREAM_NAME,
  type EventBus,
  type Subscription,
} from "@cloudmesh/events";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NatsEventPublisher } from "../../src/lib/natsPublisher.js";
import { pollOutbox, writeOutboxEvent } from "../../src/lib/outbox.js";
import {
  getDailyAnalytics,
  startAnalyticsSubscriber,
  startAuditSubscriber,
  startBillingSubscriber,
  startNotificationSubscriber,
} from "../../src/modules/events/subscribers.js";

const admin = getAdminPrisma();
const redis = new Redis(process.env.REDIS_URL!);
const NATS_URL = process.env.NATS_URL!;

async function eventually<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 75));
  }
}

async function createOrg(name = "Events Org"): Promise<string> {
  const org = await admin.organization.create({ data: { name } });
  return org.id;
}

function usagePayload(orgId: string, overrides: Record<string, unknown> = {}) {
  return {
    orgId,
    apiKeyId: randomUUID(),
    model: "gpt-4o",
    promptTokens: 342,
    completionTokens: 218,
    costUsd: 0.0031,
    requestId: `req-${randomUUID()}`,
    ...overrides,
  };
}

describe("event bus wiring (Phase 10)", () => {
  let bus: EventBus;
  const subs: Subscription[] = [];

  beforeAll(async () => {
    bus = await connectEventBus({ servers: NATS_URL, name: "gateway-events-test" });
  });
  afterAll(async () => {
    for (const s of subs) await s.stop();
    if (bus) await bus.close();
    await redis.quit();
  });
  beforeEach(async () => {
    await resetDatabase();
    await redis.flushdb();
    await bus.jsm.streams.purge(EVENT_STREAM_NAME).catch(() => undefined);
  });
  afterEach(async () => {
    while (subs.length) {
      const s = subs.pop();
      await s?.stop();
    }
  });

  describe("outbox -> NATS (the Phase 7 seam, now real)", () => {
    it("publishes an unpublished outbox row to NATS and marks it published", async () => {
      const orgId = await createOrg();
      const received: unknown[] = [];
      subs.push(
        await startAnalyticsSubscriber({ bus, db: admin, redis, onError: () => undefined }),
      );
      // Also watch raw delivery so this asserts on the bus, not just the side effect.
      const { subscribe } = await import("@cloudmesh/events");
      subs.push(
        await subscribe(bus, {
          durable: `outbox_probe_${Date.now()}`,
          filterSubject: "cloudmesh.usage.recorded",
          handler: async (p) => {
            received.push(p);
          },
        }),
      );

      await withTenant(admin, orgId, (tx) =>
        writeOutboxEvent(tx, "usage.recorded", usagePayload(orgId)),
      );

      const result = await pollOutbox(admin, new NatsEventPublisher(bus));
      expect(result).toEqual({ attempted: 1, published: 1 });

      // Row marked published, so the next poll won't republish it.
      const row = await admin.outboxEvent.findFirstOrThrow();
      expect(row.publishedAt).not.toBeNull();

      const got = await eventually(async () => (received.length > 0 ? received : undefined));
      expect(got[0]).toMatchObject({ orgId, model: "gpt-4o" });
    });

    it("leaves the row unpublished when the bus rejects the publish, so it retries", async () => {
      const orgId = await createOrg();
      await withTenant(admin, orgId, (tx) =>
        writeOutboxEvent(tx, "usage.recorded", usagePayload(orgId)),
      );

      const failing = {
        publish: async () => {
          throw new Error("bus down");
        },
      };
      const result = await pollOutbox(admin, failing);
      expect(result).toEqual({ attempted: 1, published: 0 });

      const row = await admin.outboxEvent.findFirstOrThrow();
      expect(row.publishedAt).toBeNull();

      // Recovers on a later poll once the bus is back — no event lost.
      const recovered = await pollOutbox(admin, new NatsEventPublisher(bus));
      expect(recovered.published).toBe(1);
    });
  });

  describe("analytics subscriber", () => {
    it("rolls up requests, tokens, and cost per org", async () => {
      const orgId = await createOrg();
      subs.push(
        await startAnalyticsSubscriber({ bus, db: admin, redis, onError: () => undefined }),
      );

      await bus.publish("usage.recorded", usagePayload(orgId), randomUUID());
      await bus.publish("usage.recorded", usagePayload(orgId), randomUUID());

      const stats = await eventually(async () => {
        const s = await getDailyAnalytics(redis, orgId);
        return s.requests === 2 ? s : undefined;
      });
      expect(stats.tokens).toBe((342 + 218) * 2);
      expect(stats.costUsd).toBeCloseTo(0.0062, 6);
    });

    it("never mixes one org's analytics into another's", async () => {
      const orgA = await createOrg("Analytics A");
      const orgB = await createOrg("Analytics B");
      subs.push(
        await startAnalyticsSubscriber({ bus, db: admin, redis, onError: () => undefined }),
      );

      await bus.publish("usage.recorded", usagePayload(orgA), randomUUID());

      await eventually(async () => {
        const s = await getDailyAnalytics(redis, orgA);
        return s.requests === 1 ? s : undefined;
      });
      const statsB = await getDailyAnalytics(redis, orgB);
      expect(statsB).toEqual({ requests: 0, tokens: 0, costUsd: 0 });
    });
  });

  describe("audit subscriber", () => {
    it("writes an append-only audit row for an event", async () => {
      const orgId = await createOrg();
      subs.push(await startAuditSubscriber({ bus, db: admin, redis, onError: () => undefined }));

      await bus.publish("usage.recorded", usagePayload(orgId), randomUUID());

      const row = await eventually(async () => {
        const found = await admin.auditLog.findFirst({ where: { orgId } });
        return found ?? undefined;
      });
      expect(row.eventType).toBe("usage.recorded");
      expect((row.payload as { model: string }).model).toBe("gpt-4o");
    });

    it("is idempotent under at-least-once redelivery — one row per event id", async () => {
      const orgId = await createOrg();
      subs.push(await startAuditSubscriber({ bus, db: admin, redis, onError: () => undefined }));

      const eventId = randomUUID();
      const payload = usagePayload(orgId);
      await bus.publish("usage.recorded", payload, eventId);

      await eventually(async () => {
        const found = await admin.auditLog.findFirst({ where: { orgId } });
        return found ?? undefined;
      });

      // Simulate a redelivery of the same logical event by writing it
      // directly through the same idempotent path the subscriber uses.
      await bus.publish("usage.recorded", payload, eventId);
      await new Promise((r) => setTimeout(r, 800));

      expect(await admin.auditLog.count({ where: { orgId } })).toBe(1);
    });

    it("skips an event with no org rather than writing it unscoped", async () => {
      subs.push(await startAuditSubscriber({ bus, db: admin, redis, onError: () => undefined }));

      // Valid envelope, unknown event type with no orgId — must not throw
      // and must not write anything.
      await bus.publish("system.heartbeat", { note: "no org here" }, randomUUID());
      await new Promise((r) => setTimeout(r, 800));

      expect(await admin.auditLog.count()).toBe(0);
    });
  });

  describe("billing subscriber", () => {
    it("reports metered usage when a reporter is configured", async () => {
      const orgId = await createOrg();
      const reported: Array<{ orgId: string; quantity: number }> = [];
      subs.push(
        await startBillingSubscriber({
          bus,
          db: admin,
          redis,
          onError: () => undefined,
          reportUsage: async (org, quantity) => {
            reported.push({ orgId: org, quantity });
          },
        }),
      );

      await bus.publish("usage.recorded", usagePayload(orgId), randomUUID());

      const got = await eventually(async () => (reported.length > 0 ? reported : undefined));
      expect(got[0]).toEqual({ orgId, quantity: 342 + 218 });
    });

    it("acks without reporting when Stripe isn't configured, rather than failing forever", async () => {
      const orgId = await createOrg();
      const errors: unknown[] = [];
      subs.push(
        await startBillingSubscriber({
          bus,
          db: admin,
          redis,
          onError: (e) => errors.push(e),
        }),
      );

      await bus.publish("usage.recorded", usagePayload(orgId), randomUUID());
      await new Promise((r) => setTimeout(r, 800));

      expect(errors).toEqual([]);
    });
  });

  describe("notification subscriber", () => {
    it("fires on a budget warning, and not on ordinary usage", async () => {
      const orgId = await createOrg();
      const notified: Array<{ kind: string }> = [];
      subs.push(
        await startNotificationSubscriber({
          bus,
          db: admin,
          redis,
          onError: () => undefined,
          notify: async (e) => {
            notified.push({ kind: e.kind });
          },
        }),
      );

      await bus.publish("usage.recorded", usagePayload(orgId), randomUUID());
      await bus.publish(
        "budget.warning",
        { orgId, spentUsd: 9.1, budgetUsd: 10, remainingFraction: 0.09 },
        randomUUID(),
      );

      const got = await eventually(async () => (notified.length > 0 ? notified : undefined));
      expect(got).toEqual([{ kind: "budget.warning" }]);
    });
  });

  describe("fan-out", () => {
    it("delivers one event to every interested subscriber independently", async () => {
      const orgId = await createOrg();
      const notified: unknown[] = [];
      subs.push(
        await startAnalyticsSubscriber({ bus, db: admin, redis, onError: () => undefined }),
        await startAuditSubscriber({ bus, db: admin, redis, onError: () => undefined }),
        await startNotificationSubscriber({
          bus,
          db: admin,
          redis,
          onError: () => undefined,
          notify: async (e) => {
            notified.push(e);
          },
        }),
      );

      // budget.warning is audited AND notified; usage.recorded is audited
      // AND counted by analytics. One publish each, three consumers.
      await bus.publish("usage.recorded", usagePayload(orgId), randomUUID());
      await bus.publish(
        "budget.warning",
        { orgId, spentUsd: 9.5, budgetUsd: 10, remainingFraction: 0.05 },
        randomUUID(),
      );

      await eventually(async () => {
        const count = await admin.auditLog.count({ where: { orgId } });
        return count === 2 ? count : undefined;
      });
      await eventually(async () => {
        const s = await getDailyAnalytics(redis, orgId);
        return s.requests === 1 ? s : undefined;
      });
      await eventually(async () => (notified.length === 1 ? notified : undefined));
    });
  });
});
