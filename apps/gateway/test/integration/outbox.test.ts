import { getAdminPrisma, resetDatabase, withTenant } from "@cloudmesh/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  pollOutbox,
  startOutboxPoller,
  writeOutboxEvent,
  type EventPublisher,
} from "../../src/lib/outbox.js";

const admin = getAdminPrisma();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RecordingPublisher implements EventPublisher {
  published: Array<{ eventType: string; payload: unknown }> = [];
  async publish(eventType: string, payload: unknown): Promise<void> {
    this.published.push({ eventType, payload });
  }
}

class FailingPublisher implements EventPublisher {
  async publish(): Promise<void> {
    throw new Error("bus unavailable");
  }
}

describe("writeOutboxEvent", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("writes an unpublished event as part of a transaction", async () => {
    const orgId = (await admin.organization.create({ data: { name: "Outbox Org" } })).id;
    await withTenant(admin, orgId, (tx) => writeOutboxEvent(tx, "test.event", { orgId }));

    const rows = await admin.outboxEvent.findMany({ where: { eventType: "test.event" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.publishedAt).toBeNull();
    expect(rows[0]?.payload).toEqual({ orgId });
  });
});

describe("pollOutbox", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("publishes every unpublished event and marks it published", async () => {
    const orgId = (await admin.organization.create({ data: { name: "Outbox Org" } })).id;
    await withTenant(admin, orgId, (tx) => writeOutboxEvent(tx, "usage.recorded", { n: 1 }));
    await withTenant(admin, orgId, (tx) => writeOutboxEvent(tx, "budget.warning", { n: 2 }));

    const publisher = new RecordingPublisher();
    const result = await pollOutbox(admin, publisher);

    expect(result).toEqual({ attempted: 2, published: 2 });
    expect(publisher.published).toHaveLength(2);

    const remaining = await admin.outboxEvent.count({ where: { publishedAt: null } });
    expect(remaining).toBe(0);
  });

  it("never re-publishes an already-published event", async () => {
    const orgId = (await admin.organization.create({ data: { name: "Outbox Org" } })).id;
    await withTenant(admin, orgId, (tx) => writeOutboxEvent(tx, "usage.recorded", { n: 1 }));

    const publisher = new RecordingPublisher();
    await pollOutbox(admin, publisher);
    await pollOutbox(admin, publisher);

    expect(publisher.published).toHaveLength(1);
  });

  it("leaves a failed event unpublished for the next poll, without blocking the rest of the batch", async () => {
    const orgId = (await admin.organization.create({ data: { name: "Outbox Org" } })).id;
    await withTenant(admin, orgId, (tx) => writeOutboxEvent(tx, "will.fail", { n: 1 }));
    await withTenant(admin, orgId, (tx) => writeOutboxEvent(tx, "will.succeed", { n: 2 }));

    const publisher: EventPublisher = {
      publish: async (eventType) => {
        if (eventType === "will.fail") throw new Error("bus unavailable");
      },
    };
    const result = await pollOutbox(admin, publisher);

    expect(result).toEqual({ attempted: 2, published: 1 });
    const stillPending = await admin.outboxEvent.findMany({ where: { publishedAt: null } });
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0]?.eventType).toBe("will.fail");
  });

  it("a previously-failed event succeeds on a later poll once the publisher recovers", async () => {
    const orgId = (await admin.organization.create({ data: { name: "Outbox Org" } })).id;
    await withTenant(admin, orgId, (tx) => writeOutboxEvent(tx, "flaky.event", { n: 1 }));

    await pollOutbox(admin, new FailingPublisher());
    expect(await admin.outboxEvent.count({ where: { publishedAt: null } })).toBe(1);

    const recovered = new RecordingPublisher();
    await pollOutbox(admin, recovered);
    expect(recovered.published).toHaveLength(1);
    expect(await admin.outboxEvent.count({ where: { publishedAt: null } })).toBe(0);
  });

  it("processes events oldest-first", async () => {
    const orgId = (await admin.organization.create({ data: { name: "Outbox Org" } })).id;
    await withTenant(admin, orgId, (tx) => writeOutboxEvent(tx, "first", { n: 1 }));
    await sleep(10);
    await withTenant(admin, orgId, (tx) => writeOutboxEvent(tx, "second", { n: 2 }));

    const publisher = new RecordingPublisher();
    await pollOutbox(admin, publisher);

    expect(publisher.published.map((p) => p.eventType)).toEqual(["first", "second"]);
  });
});

describe("startOutboxPoller", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("publishes pending events on a timer until stopped", async () => {
    const orgId = (await admin.organization.create({ data: { name: "Outbox Org" } })).id;
    await withTenant(admin, orgId, (tx) => writeOutboxEvent(tx, "timed.event", { n: 1 }));

    const publisher = new RecordingPublisher();
    const onError = vi.fn();
    const handle = startOutboxPoller(admin, publisher, 20, onError);

    await sleep(100);
    handle.stop();

    expect(publisher.published.length).toBeGreaterThanOrEqual(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("stops polling once stop() is called", async () => {
    const publisher = new RecordingPublisher();
    const handle = startOutboxPoller(admin, publisher, 15, () => undefined);
    await sleep(40);
    handle.stop();

    const countAtStop = publisher.published.length;
    const orgId = (await admin.organization.create({ data: { name: "Late Org" } })).id;
    await withTenant(admin, orgId, (tx) => writeOutboxEvent(tx, "after.stop", { n: 1 }));
    await sleep(60);

    // Nothing new published after stop(), even though a new event exists.
    expect(publisher.published.length).toBe(countAtStop);
  });

  it("reports polling errors via onError without crashing the loop", async () => {
    const throwingPrisma = {
      outboxEvent: {
        findMany: () => Promise.reject(new Error("db down")),
      },
    } as unknown as Parameters<typeof startOutboxPoller>[0];

    const onError = vi.fn();
    const handle = startOutboxPoller(throwingPrisma, new RecordingPublisher(), 15, onError);
    await sleep(40);
    handle.stop();

    expect(onError).toHaveBeenCalled();
  });
});
