import { getAdminPrisma } from "@cloudmesh/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApiKey, createTestApp, resetAll } from "./helpers.js";

/**
 * Phase 11 shipped `request.rate_limited` and `provider.degraded` as
 * schema-valid, subscribable event types with no live publisher. These
 * tests cover the publishers added since — specifically the property that
 * makes them safe to run on the hot path at all: the Redis dedupe.
 *
 * `outbox_events` has no RLS (it's only ever touched by internal system
 * processes — see CLAUDE.md's Phase 7 notes), so these read it through the
 * admin client directly rather than `withTenant`.
 */
const admin = getAdminPrisma();

async function rateLimitedEvents(orgId: string) {
  const rows = await admin.outboxEvent.findMany({
    where: { eventType: "request.rate_limited" },
    orderBy: { createdAt: "asc" },
  });
  return rows.filter((r) => (r.payload as { orgId?: string }).orgId === orgId);
}

describe("platform event publishers (Phase 11 gap)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetAll(app);
  });

  it("writes a request.rate_limited outbox event when a request is rejected", async () => {
    const { rawKey, orgId } = await createTestApiKey("Events Org", 1);
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "hi" }] };
    const headers = { authorization: `Bearer ${rawKey}` };

    await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
    const rejected = await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
    expect(rejected.statusCode).toBe(429);

    const events = await rateLimitedEvents(orgId);
    expect(events).toHaveLength(1);

    const body = events[0]!.payload as Record<string, unknown>;
    expect(body.orgId).toBe(orgId);
    expect(body.retryAfterSeconds).toBeTypeOf("number");
    // Tells a consumer the event represents a window, not one request.
    expect(body.dedupeWindowSeconds).toBe(60);
  });

  it("emits at most ONE event per org per window no matter how many requests are rejected", async () => {
    // This is the property that stops the rate limiter — whose whole job is
    // shedding load — from becoming a DB write amplifier under exactly the
    // abusive traffic it exists to stop.
    const { rawKey, orgId } = await createTestApiKey("Flood Org", 1);
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "hi" }] };
    const headers = { authorization: `Bearer ${rawKey}` };

    await app.inject({ method: "POST", url: "/v1/chat", headers, payload });

    const rejections = await Promise.all(
      Array.from({ length: 25 }, () =>
        app.inject({ method: "POST", url: "/v1/chat", headers, payload }),
      ),
    );
    expect(rejections.every((r) => r.statusCode === 429)).toBe(true);

    // 25 rejections, exactly 1 durable event.
    expect(await rateLimitedEvents(orgId)).toHaveLength(1);
  });

  it("does not suppress another org's event via the first org's dedupe slot", async () => {
    const a = await createTestApiKey("Org A", 1);
    const b = await createTestApiKey("Org B", 1);
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "hi" }] };

    for (const key of [a.rawKey, b.rawKey]) {
      const headers = { authorization: `Bearer ${key}` };
      await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
      const rejected = await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
      expect(rejected.statusCode).toBe(429);
    }

    expect(await rateLimitedEvents(a.orgId)).toHaveLength(1);
    expect(await rateLimitedEvents(b.orgId)).toHaveLength(1);
  });

  it("never leaks another org's id into an org's own event payload", async () => {
    const a = await createTestApiKey("Tenant A", 1);
    const b = await createTestApiKey("Tenant B", 1);
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "hi" }] };

    for (const key of [a.rawKey, b.rawKey]) {
      const headers = { authorization: `Bearer ${key}` };
      await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
      await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
    }

    const eventsA = await rateLimitedEvents(a.orgId);
    expect(eventsA).toHaveLength(1);
    expect(JSON.stringify(eventsA[0]!.payload)).not.toContain(b.orgId);
  });

  it("still returns a correct 429 to the caller even though an event was written", async () => {
    // The emission is awaited on the rejection path; it must not change the
    // response the caller sees, nor swallow the Retry-After header.
    const { rawKey } = await createTestApiKey("Response Org", 1);
    const payload = { model: "mock-echo", messages: [{ role: "user", content: "hi" }] };
    const headers = { authorization: `Bearer ${rawKey}` };

    await app.inject({ method: "POST", url: "/v1/chat", headers, payload });
    const rejected = await app.inject({ method: "POST", url: "/v1/chat", headers, payload });

    expect(rejected.statusCode).toBe(429);
    expect(rejected.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(rejected.headers["retry-after"]).toBeDefined();
  });
});
