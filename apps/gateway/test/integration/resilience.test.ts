import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { ServiceUnavailableError } from "../../src/errors.js";
import { callProviderResilient } from "../../src/lib/resilience.js";

const redis = new Redis(process.env.REDIS_URL!);
afterAll(() => redis.disconnect());

function providerName(): string {
  return `test-provider-${randomUUID()}`;
}

describe("callProviderResilient", () => {
  it("retries a transient failure and returns the eventual success", async () => {
    const name = providerName();
    let calls = 0;

    const result = await callProviderResilient(redis, name, async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return "recovered";
    });

    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("throws the underlying error after exhausting retries against a persistent failure", async () => {
    const name = providerName();
    await expect(
      callProviderResilient(redis, name, async () => {
        throw new Error("permanently broken");
      }),
    ).rejects.toThrow("permanently broken");
  });

  it("trips the circuit after enough failures, then fails fast as ServiceUnavailableError", async () => {
    const name = providerName();

    // CIRCUIT_FAILURE_THRESHOLD is 2 in the test env — a couple of failing
    // requests (each already retried internally) is enough to trip it.
    for (let i = 0; i < 3; i++) {
      await expect(
        callProviderResilient(redis, name, async () => {
          throw new Error("down");
        }),
      ).rejects.toThrow();
    }

    let called = false;
    await expect(
      callProviderResilient(redis, name, async () => {
        called = true;
        return "should not run";
      }),
    ).rejects.toThrow(ServiceUnavailableError);
    expect(called).toBe(false);
  });

  it("ServiceUnavailableError carries a Retry-After header", async () => {
    const name = providerName();
    for (let i = 0; i < 3; i++) {
      await expect(
        callProviderResilient(redis, name, async () => {
          throw new Error("down");
        }),
      ).rejects.toThrow();
    }

    try {
      await callProviderResilient(redis, name, async () => "unreachable");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableError);
      const svcErr = err as ServiceUnavailableError;
      expect(svcErr.statusCode).toBe(503);
      expect(svcErr.headers?.["Retry-After"]).toBeDefined();
      expect(Number(svcErr.headers?.["Retry-After"])).toBeGreaterThan(0);
    }
  });

  it("recovers after the circuit's open duration passes (half-open probe succeeds)", async () => {
    const name = providerName();
    for (let i = 0; i < 3; i++) {
      await expect(
        callProviderResilient(redis, name, async () => {
          throw new Error("down");
        }),
      ).rejects.toThrow();
    }
    await expect(callProviderResilient(redis, name, async () => "still down")).rejects.toThrow(
      ServiceUnavailableError,
    );

    // CIRCUIT_OPEN_DURATION_MS is 200ms in the test env.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const result = await callProviderResilient(redis, name, async () => "recovered");
    expect(result).toBe("recovered");
  });
});
