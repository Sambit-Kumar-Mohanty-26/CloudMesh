import { createHash, createHmac } from "node:crypto";
import { getAdminPrisma } from "@cloudmesh/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signAccessToken } from "../../src/lib/jwt.js";
import { createTestApp, resetAll } from "./helpers.js";

const admin = getAdminPrisma();
const WEBHOOK_SECRET = "whsec_test_secret";

async function registerAndLogin(app: FastifyInstance, email = "owner@acme.test") {
  const register = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { orgName: "Acme", email, password: "correct-horse-1" },
  });
  const { orgId } = register.json();
  const loginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: "correct-horse-1" },
  });
  return { accessToken: loginRes.json().accessToken as string, orgId: orgId as string };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function signStripePayload(payload: string, timestamp: number): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");
}

function stripeHeaders(payload: string, timestamp: number = Math.floor(Date.now() / 1000)) {
  return { "stripe-signature": `t=${timestamp},v1=${signStripePayload(payload, timestamp)}` };
}

describe("GET /billing/status", () => {
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

  it("rejects without a valid JWT", async () => {
    const res = await app.inject({ method: "GET", url: "/billing/status" });
    expect(res.statusCode).toBe(401);
  });

  it("returns budget status for the authenticated org", async () => {
    await admin.billingPlan.create({
      data: { planTier: "FREE", monthlyBudgetUsd: 5, priceUsd: 0 },
    });
    const { accessToken } = await registerAndLogin(app);

    const res = await app.inject({
      method: "GET",
      url: "/billing/status",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ budgetUsd: 5, spentUsd: 0, remainingUsd: 5 });
  });
});

describe("PATCH /billing/budget", () => {
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

  it("lets an OWNER set a budget override", async () => {
    const { accessToken, orgId } = await registerAndLogin(app);

    const res = await app.inject({
      method: "PATCH",
      url: "/billing/budget",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { monthlyBudgetOverrideUsd: 250 },
    });
    expect(res.statusCode).toBe(204);

    const org = await admin.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(Number(org.monthlyBudgetOverrideUsd)).toBe(250);
  });

  it("lets an OWNER clear the override with null", async () => {
    const { accessToken, orgId } = await registerAndLogin(app);
    await admin.organization.update({
      where: { id: orgId },
      data: { monthlyBudgetOverrideUsd: 250 },
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/billing/budget",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { monthlyBudgetOverrideUsd: null },
    });
    expect(res.statusCode).toBe(204);

    const org = await admin.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.monthlyBudgetOverrideUsd).toBeNull();
  });

  it("rejects a MEMBER trying to change the budget", async () => {
    const { orgId } = await registerAndLogin(app);
    const member = await admin.user.create({
      data: {
        email: "member@acme.test",
        passwordHash: sha256("unused"),
        role: "MEMBER",
        orgId,
      },
    });
    const memberToken = signAccessToken({ sub: member.id, orgId, role: "MEMBER" });

    const res = await app.inject({
      method: "PATCH",
      url: "/billing/budget",
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { monthlyBudgetOverrideUsd: 999 },
    });
    expect(res.statusCode).toBe(403);

    const org = await admin.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.monthlyBudgetOverrideUsd).toBeNull();
  });

  it("rejects a negative or zero budget", async () => {
    const { accessToken } = await registerAndLogin(app);
    const res = await app.inject({
      method: "PATCH",
      url: "/billing/budget",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { monthlyBudgetOverrideUsd: -5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("never lets one org's budget update touch another org's row", async () => {
    const { accessToken: tokenA } = await registerAndLogin(app, "a@acme.test");
    const { orgId: orgB } = await registerAndLogin(app, "b@acme.test");

    await app.inject({
      method: "PATCH",
      url: "/billing/budget",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { monthlyBudgetOverrideUsd: 42 },
    });

    const orgBRow = await admin.organization.findUniqueOrThrow({ where: { id: orgB } });
    expect(orgBRow.monthlyBudgetOverrideUsd).toBeNull();
  });
});

describe("GET /billing/invoices", () => {
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

  it("returns an empty list for an org with no invoices", async () => {
    const { accessToken } = await registerAndLogin(app);
    const res = await app.inject({
      method: "GET",
      url: "/billing/invoices",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("never returns another org's invoices", async () => {
    const { accessToken: tokenA } = await registerAndLogin(app, "a@acme.test");
    const { orgId: orgB } = await registerAndLogin(app, "b@acme.test");
    await admin.invoice.create({
      data: {
        orgId: orgB,
        stripeInvoiceId: "in_org_b",
        periodStart: new Date("2026-01-01"),
        periodEnd: new Date("2026-02-01"),
        amountUsd: 99,
        status: "PAID",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/billing/invoices",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.json()).toEqual([]);
  });
});

describe("POST /billing/webhook", () => {
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

  it("rejects a request with no Stripe-Signature header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      payload: { id: "evt_1", type: "invoice.paid", data: { object: {} } },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a forged signature", async () => {
    const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
    const res = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "content-type": "application/json", ...stripeHeaders(payload) },
      payload: '{"id":"evt_1","type":"invoice.paid","tampered":true,"data":{"object":{}}}',
    });
    expect(res.statusCode).toBe(401);
  });

  it("creates an invoice for the matching org on invoice.paid, and dedups a redelivered event", async () => {
    const { orgId } = await registerAndLogin(app);
    await admin.organization.update({
      where: { id: orgId },
      data: { stripeCustomerId: "cus_123" },
    });

    const payload = JSON.stringify({
      id: "evt_paid_1",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_abc",
          customer: "cus_123",
          period_start: 1_700_000_000,
          period_end: 1_702_592_000,
          amount_paid: 4900,
        },
      },
    });

    const first = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "content-type": "application/json", ...stripeHeaders(payload) },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ processed: true });

    const invoice = await admin.invoice.findUnique({ where: { stripeInvoiceId: "in_abc" } });
    expect(invoice).not.toBeNull();
    expect(invoice?.orgId).toBe(orgId);
    expect(Number(invoice?.amountUsd)).toBe(49);
    expect(invoice?.status).toBe("PAID");

    // Redelivery of the exact same event id must not double-process.
    const second = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "content-type": "application/json", ...stripeHeaders(payload) },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().processed).toBe(false);

    const count = await admin.invoice.count({ where: { stripeInvoiceId: "in_abc" } });
    expect(count).toBe(1);
  });

  it("reports unprocessed (but still 200) for a customer that maps to no org, without crashing", async () => {
    const payload = JSON.stringify({
      id: "evt_unknown_customer",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_orphan",
          customer: "cus_does_not_exist",
          period_start: 1_700_000_000,
          period_end: 1_702_592_000,
          amount_paid: 100,
        },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "content-type": "application/json", ...stripeHeaders(payload) },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().processed).toBe(false);
  });

  it("reports unprocessed for an event type it doesn't act on, without erroring", async () => {
    const payload = JSON.stringify({
      id: "evt_unhandled",
      type: "customer.updated",
      data: { object: {} },
    });

    const res = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: { "content-type": "application/json", ...stripeHeaders(payload) },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().processed).toBe(false);
  });
});
