import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, resetAll } from "./helpers.js";

describe("security: rate limiting", () => {
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

  it("throttles repeated login attempts (brute-force baseline)", async () => {
    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "nobody@acme.test", password: "guess-1" },
      });

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await attempt());
    }

    const statusCodes = results.map((r) => r.statusCode);
    expect(statusCodes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(statusCodes[5]).toBe(429);
  });

  it("throttles repeated register attempts", async () => {
    const attempt = (i: number) =>
      app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { orgName: "Acme", email: `flood-${i}@acme.test`, password: "correct-horse-1" },
      });

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await attempt(i));
    }

    expect(results[5]?.statusCode).toBe(429);
  });
});

describe("security: malformed/hostile input", () => {
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

  it("rejects malformed JSON with 400, not a 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{not valid json",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a wildly oversized payload without crashing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        orgName: "Acme",
        email: "big@acme.test",
        password: "correct-horse-1",
        junk: "x".repeat(5_000_000),
      },
    });
    // Either Fastify's body-limit middleware or zod's schema validation
    // (junk isn't a declared field, but the parse itself must still not
    // choke) must turn this into an ordinary 4xx, never a crash/500.
    expect(res.statusCode).toBeLessThan(500);
  });

  it("rejects non-string password types instead of coercing them", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "user@acme.test", password: { $ne: null } },
    });
    // A NoSQL-injection-style operator object must be rejected by schema
    // validation, not passed through to a query.
    expect(res.statusCode).toBe(400);
  });

  it("rejects an array where a string is expected", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: ["a@acme.test", "b@acme.test"], password: "correct-horse-1" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("security: login timing does not reveal account existence", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetAll(app);
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { orgName: "Acme", email: "real@acme.test", password: "correct-horse-1" },
    });
  });

  it("responds in the same order of magnitude whether or not the account exists", async () => {
    // Soft/statistical by necessity — this asserts the dummy-hash path
    // hasn't regressed into a fast short-circuit (e.g. someone "optimizing"
    // away the constant-time compare), not a precise timing bound.
    const time = async (payload: object) => {
      const start = performance.now();
      await app.inject({ method: "POST", url: "/auth/login", payload });
      return performance.now() - start;
    };

    const existingUserTimes: number[] = [];
    const missingUserTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      existingUserTimes.push(await time({ email: "real@acme.test", password: "wrong-password" }));
      missingUserTimes.push(
        await time({ email: `nobody-${i}@acme.test`, password: "wrong-password" }),
      );
    }

    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const existingAvg = avg(existingUserTimes);
    const missingAvg = avg(missingUserTimes);

    // Generous ratio bound: real regressions (skipping bcrypt entirely on
    // one path) show up as >10x, not the small jitter this would flag.
    const ratio = Math.max(existingAvg, missingAvg) / Math.min(existingAvg, missingAvg);
    expect(ratio).toBeLessThan(5);
  });
});
