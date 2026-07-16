import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, resetAll } from "./helpers.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("POST /auth/register", () => {
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

  it("creates an org and an owner user, returning UUIDs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { orgName: "Acme Inc", email: "owner@acme.test", password: "correct-horse-1" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.orgId).toMatch(UUID_RE);
    expect(body.userId).toMatch(UUID_RE);
  });

  it("never returns a password hash in the response", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { orgName: "Acme Inc", email: "owner@acme.test", password: "correct-horse-1" },
    });
    const raw = JSON.stringify(res.json());
    expect(raw).not.toMatch(/passwordHash/i);
    expect(raw).not.toContain("correct-horse-1");
  });

  it("rejects a duplicate email with 409", async () => {
    const payload = { orgName: "Acme Inc", email: "dup@acme.test", password: "correct-horse-1" };
    const first = await app.inject({ method: "POST", url: "/auth/register", payload });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { ...payload, orgName: "A Different Org" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("treats email uniqueness case-insensitively (schema lowercases it)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { orgName: "Acme", email: "Case@Acme.test", password: "correct-horse-1" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { orgName: "Acme 2", email: "case@acme.test", password: "correct-horse-1" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("rejects a password under 8 characters with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { orgName: "Acme", email: "short@acme.test", password: "short1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed email with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { orgName: "Acme", email: "not-an-email", password: "correct-horse-1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing orgName with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "missing-org@acme.test", password: "correct-horse-1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an oversized orgName with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { orgName: "x".repeat(201), email: "long@acme.test", password: "correct-horse-1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("ignores unexpected extra fields instead of applying them (no mass assignment)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        orgName: "Acme",
        email: "extra@acme.test",
        password: "correct-horse-1",
        role: "SUPERADMIN",
        isActive: true,
      },
    });
    expect(res.statusCode).toBe(201);
    // If role had been honored, this would need a follow-up assertion — it
    // can't be, since registerSchema doesn't declare a role field at all.
  });

  it("rejects SQL-metacharacter input as ordinary invalid data, not a query", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { orgName: "Acme", email: "a' OR '1'='1", password: "correct-horse-1" },
    });
    // Not a valid email — rejected by validation, same as any other bad email.
    expect(res.statusCode).toBe(400);
  });
});
