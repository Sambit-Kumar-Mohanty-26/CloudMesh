import { getAdminPrisma, resetDatabase, withTenant } from "@cloudmesh/db";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchWebhookEvent } from "../src/service.js";
import { createWebhookQueue, createWebhookWorker } from "../src/queue.js";
import { WEBHOOK_MAX_ATTEMPTS, type WebhookEventType } from "../src/types.js";
import {
  readRequestBody,
  startTestHttpsServer,
  trustTestCert,
  type TestHttpsServerHandle,
} from "./helpers.js";

/**
 * The full loop deliver.test.ts and events.test.ts each only cover half of:
 * NATS event -> dispatchWebhookEvent (enqueue) -> real BullMQ worker ->
 * real HTTP -> DB status. This file is the other half — a real Redis queue
 * and a real createWebhookWorker consuming it, proving retry scheduling and
 * DB status transitions (PENDING -> DELIVERED/FAILED/EXHAUSTED) actually
 * work wired together, not just as isolated pure functions.
 *
 * Every worker here is built with a short, injectable retryScheduleMs and a
 * stubbed checkTarget — see queue.ts's WebhookWorkerOptions comment for why
 * both are test-only overrides that production code never sets: the real
 * schedule tops out at 30 minutes, and a real webhook target is never
 * loopback (the real SSRF guard would reject the local test server used
 * here, which is the whole point of deliver.test.ts's separate SSRF-gating
 * tests).
 */

const admin = getAdminPrisma();
const redis = new Redis(process.env.REDIS_URL!);
const FAST_SCHEDULE = [50, 50, 50, 50, 50];

async function eventually<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function createOrg(name = "Webhook Pipeline Org"): Promise<string> {
  const org = await admin.organization.create({ data: { name } });
  return org.id;
}

async function createEndpoint(
  orgId: string,
  url: string,
  eventTypes: string[] = ["job.completed"],
) {
  return withTenant(admin, orgId, (tx) =>
    tx.webhookEndpoint.create({
      data: { orgId, url, secret: "whsec_pipeline_test", eventTypes },
    }),
  );
}

let restoreDispatcher: () => void;
const handles: TestHttpsServerHandle[] = [];
let queue: ReturnType<typeof createWebhookQueue>;
let worker: ReturnType<typeof createWebhookWorker> | undefined;

beforeEach(async () => {
  await resetDatabase();
  await redis.flushdb();
  restoreDispatcher = trustTestCert();
  queue = createWebhookQueue(redis);
});

afterEach(async () => {
  restoreDispatcher();
  await worker?.close();
  worker = undefined;
  await queue.close();
  while (handles.length) {
    await handles.pop()!.close();
  }
});

describe("webhook delivery pipeline (dispatch -> queue -> worker -> HTTP -> DB)", () => {
  it("delivers end to end and records DELIVERED with the real response status", async () => {
    const orgId = await createOrg();
    let received: { signature?: string; body: string } | undefined;
    const handle = await startTestHttpsServer((req, res) => {
      readRequestBody(req).then((body) => {
        received = { signature: req.headers["x-cloudmesh-signature"] as string, body };
        res.writeHead(200);
        res.end("ok");
      });
    });
    handles.push(handle);
    await createEndpoint(orgId, handle.url);

    worker = createWebhookWorker(redis, {
      db: admin,
      checkTarget: async () => ({ safe: true }),
      retryScheduleMs: FAST_SCHEDULE,
    });

    const { deliveryCount } = await dispatchWebhookEvent(
      admin,
      queue,
      orgId,
      "job.completed" as WebhookEventType,
      { orgId, jobId: "job-1" },
    );
    expect(deliveryCount).toBe(1);

    const delivery = await eventually(async () => {
      const found = await admin.webhookDelivery.findFirst({ where: { orgId } });
      return found && found.status !== "PENDING" ? found : undefined;
    });
    expect(delivery.status).toBe("DELIVERED");
    expect(delivery.responseStatus).toBe(200);
    expect(delivery.attempts).toBe(1);
    expect(received?.signature).toBeDefined();
  });

  it("records FAILED on a 4xx response, with no retry (single request received)", async () => {
    const orgId = await createOrg();
    let requestCount = 0;
    const handle = await startTestHttpsServer((_req, res) => {
      requestCount++;
      res.writeHead(422);
      res.end("nope");
    });
    handles.push(handle);
    await createEndpoint(orgId, handle.url);

    worker = createWebhookWorker(redis, {
      db: admin,
      checkTarget: async () => ({ safe: true }),
      retryScheduleMs: FAST_SCHEDULE,
    });

    await dispatchWebhookEvent(admin, queue, orgId, "job.completed" as WebhookEventType, { orgId });

    const delivery = await eventually(async () => {
      const found = await admin.webhookDelivery.findFirst({ where: { orgId } });
      return found && found.status !== "PENDING" ? found : undefined;
    });
    expect(delivery.status).toBe("FAILED");
    expect(delivery.responseStatus).toBe(422);

    // Give any (incorrect) retry a chance to have fired before asserting.
    await new Promise((r) => setTimeout(r, 300));
    expect(requestCount).toBe(1);
  });

  it("does not follow a redirect, and records it as FAILED", async () => {
    const orgId = await createOrg();
    let redirectTargetHit = false;
    const handle = await startTestHttpsServer((req, res) => {
      if (req.url === "/webhook") {
        res.writeHead(302, { Location: "https://localhost/elsewhere" });
        res.end();
      } else {
        redirectTargetHit = true;
        res.writeHead(200);
        res.end();
      }
    });
    handles.push(handle);
    await createEndpoint(orgId, handle.url);

    worker = createWebhookWorker(redis, {
      db: admin,
      checkTarget: async () => ({ safe: true }),
      retryScheduleMs: FAST_SCHEDULE,
    });

    await dispatchWebhookEvent(admin, queue, orgId, "job.completed" as WebhookEventType, { orgId });

    const delivery = await eventually(async () => {
      const found = await admin.webhookDelivery.findFirst({ where: { orgId } });
      return found && found.status !== "PENDING" ? found : undefined;
    });
    expect(delivery.status).toBe("FAILED");
    expect(delivery.responseStatus).toBe(302);
    expect(redirectTargetHit).toBe(false);
  });

  it("retries a 5xx and recovers to DELIVERED once the server starts succeeding", async () => {
    const orgId = await createOrg();
    let attempts = 0;
    const handle = await startTestHttpsServer((_req, res) => {
      attempts++;
      if (attempts < 3) {
        res.writeHead(503);
        res.end("unavailable");
      } else {
        res.writeHead(200);
        res.end("ok");
      }
    });
    handles.push(handle);
    await createEndpoint(orgId, handle.url);

    worker = createWebhookWorker(redis, {
      db: admin,
      checkTarget: async () => ({ safe: true }),
      retryScheduleMs: FAST_SCHEDULE,
    });

    await dispatchWebhookEvent(admin, queue, orgId, "job.completed" as WebhookEventType, { orgId });

    const delivery = await eventually(async () => {
      const found = await admin.webhookDelivery.findFirst({ where: { orgId } });
      return found && found.status === "DELIVERED" ? found : undefined;
    });
    expect(delivery.attempts).toBe(3);
    expect(attempts).toBe(3);
  });

  it("exhausts every retry and marks EXHAUSTED when the server never recovers", async () => {
    const orgId = await createOrg();
    let attempts = 0;
    const handle = await startTestHttpsServer((_req, res) => {
      attempts++;
      res.writeHead(500);
      res.end("still down");
    });
    handles.push(handle);
    await createEndpoint(orgId, handle.url);

    worker = createWebhookWorker(redis, {
      db: admin,
      checkTarget: async () => ({ safe: true }),
      retryScheduleMs: FAST_SCHEDULE,
    });

    await dispatchWebhookEvent(admin, queue, orgId, "job.completed" as WebhookEventType, { orgId });

    const delivery = await eventually(
      async () => {
        const found = await admin.webhookDelivery.findFirst({ where: { orgId } });
        return found && found.status === "EXHAUSTED" ? found : undefined;
      },
      // 5 backoffs of 50ms plus 6 real HTTP round trips comfortably fit
      // inside this window without needing the real 30-minute schedule.
      15_000,
    );
    expect(delivery.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
  });

  it("fans out to every subscribed endpoint independently", async () => {
    const orgId = await createOrg();
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const handleA = await startTestHttpsServer((_req, res) => {
      receivedA.push("hit");
      res.writeHead(200);
      res.end("ok");
    });
    const handleB = await startTestHttpsServer((_req, res) => {
      receivedB.push("hit");
      res.writeHead(200);
      res.end("ok");
    });
    handles.push(handleA, handleB);
    await createEndpoint(orgId, handleA.url);
    await createEndpoint(orgId, handleB.url);

    worker = createWebhookWorker(redis, {
      db: admin,
      checkTarget: async () => ({ safe: true }),
      retryScheduleMs: FAST_SCHEDULE,
    });

    const { deliveryCount } = await dispatchWebhookEvent(
      admin,
      queue,
      orgId,
      "job.completed" as WebhookEventType,
      { orgId },
    );
    expect(deliveryCount).toBe(2);

    await eventually(async () => {
      const count = await admin.webhookDelivery.count({ where: { orgId, status: "DELIVERED" } });
      return count === 2 ? count : undefined;
    });
    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);
  });

  it("never dispatches to an endpoint not subscribed to that event type", async () => {
    const orgId = await createOrg();
    let hit = false;
    const handle = await startTestHttpsServer((_req, res) => {
      hit = true;
      res.writeHead(200);
      res.end("ok");
    });
    handles.push(handle);
    // Subscribed only to job.failed — job.completed must not reach it.
    await createEndpoint(orgId, handle.url, ["job.failed"]);

    worker = createWebhookWorker(redis, {
      db: admin,
      checkTarget: async () => ({ safe: true }),
      retryScheduleMs: FAST_SCHEDULE,
    });

    const { deliveryCount } = await dispatchWebhookEvent(
      admin,
      queue,
      orgId,
      "job.completed" as WebhookEventType,
      { orgId },
    );
    expect(deliveryCount).toBe(0);

    await new Promise((r) => setTimeout(r, 300));
    expect(hit).toBe(false);
    expect(await admin.webhookDelivery.count({ where: { orgId } })).toBe(0);
  });

  it("never lets org B's endpoint receive an event dispatched for org A", async () => {
    const orgA = await createOrg("Org A");
    const orgB = await createOrg("Org B");
    let hitB = false;
    const handleB = await startTestHttpsServer((_req, res) => {
      hitB = true;
      res.writeHead(200);
      res.end("ok");
    });
    handles.push(handleB);
    await createEndpoint(orgB, handleB.url);

    worker = createWebhookWorker(redis, {
      db: admin,
      checkTarget: async () => ({ safe: true }),
      retryScheduleMs: FAST_SCHEDULE,
    });

    const { deliveryCount } = await dispatchWebhookEvent(
      admin,
      queue,
      orgA,
      "job.completed" as WebhookEventType,
      { orgId: orgA },
    );
    expect(deliveryCount).toBe(0);

    await new Promise((r) => setTimeout(r, 300));
    expect(hitB).toBe(false);
    expect(await admin.webhookDelivery.count({ where: { orgId: orgB } })).toBe(0);
  });
});
