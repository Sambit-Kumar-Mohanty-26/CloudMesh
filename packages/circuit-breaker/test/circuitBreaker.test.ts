import { afterAll, describe, expect, it, vi } from "vitest";
import {
  CircuitOpenError,
  forceOpenCircuit,
  getCircuitState,
  resetCircuit,
  withCircuitBreaker,
} from "../src/index.js";
import { createTestRedis, testName } from "./helpers.js";

const redis = createTestRedis();
afterAll(() => redis.disconnect());

const config = { failureThreshold: 3, failureWindowMs: 60_000, openDurationMs: 30_000 };

describe("withCircuitBreaker — closed state", () => {
  it("allows calls through and stays closed while under the failure threshold", async () => {
    const name = testName();
    for (let i = 0; i < 2; i++) {
      await expect(
        withCircuitBreaker(redis, name, config, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    }
    expect(await getCircuitState(redis, name)).toBe("closed");
  });

  it("passes through the return value on success", async () => {
    const name = testName();
    const result = await withCircuitBreaker(redis, name, config, async () => "ok");
    expect(result).toBe("ok");
    expect(await getCircuitState(redis, name)).toBe("closed");
  });
});

describe("withCircuitBreaker — tripping open", () => {
  it("opens after `failureThreshold` failures and then fails fast without calling fn", async () => {
    const name = testName();
    for (let i = 0; i < 3; i++) {
      await expect(
        withCircuitBreaker(redis, name, config, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    }
    expect(await getCircuitState(redis, name)).toBe("open");

    const fn = vi.fn(async () => "should not run");
    await expect(withCircuitBreaker(redis, name, config, fn)).rejects.toThrow(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("resets the failure count once the window passes, so stale failures don't accumulate", async () => {
    const name = testName();
    const shortWindowConfig = { ...config, failureWindowMs: 100 };
    const now = 1_000_000;

    await expect(
      withCircuitBreaker(
        redis,
        name,
        shortWindowConfig,
        async () => {
          throw new Error("boom");
        },
        now,
      ),
    ).rejects.toThrow();
    await expect(
      withCircuitBreaker(
        redis,
        name,
        shortWindowConfig,
        async () => {
          throw new Error("boom");
        },
        now + 10,
      ),
    ).rejects.toThrow();
    // 2 failures so far, threshold is 3 — window resets before a 3rd lands.
    await expect(
      withCircuitBreaker(
        redis,
        name,
        shortWindowConfig,
        async () => {
          throw new Error("boom");
        },
        now + 500,
      ),
    ).rejects.toThrow();

    expect(await getCircuitState(redis, name)).toBe("closed");
  });
});

describe("withCircuitBreaker — half-open recovery", () => {
  it("transitions to half_open after openDurationMs and allows exactly one probe", async () => {
    const name = testName();
    const now = 2_000_000;

    for (let i = 0; i < 3; i++) {
      await expect(
        withCircuitBreaker(
          redis,
          name,
          config,
          async () => {
            throw new Error("boom");
          },
          now,
        ),
      ).rejects.toThrow();
    }
    expect(await getCircuitState(redis, name)).toBe("open");

    // Before openDurationMs has passed: still fails fast.
    await expect(
      withCircuitBreaker(redis, name, config, async () => "probe", now + 1000),
    ).rejects.toThrow(CircuitOpenError);

    // At/after openDurationMs: one probe request gets through.
    const afterOpen = now + config.openDurationMs;
    const result = await withCircuitBreaker(redis, name, config, async () => "probe ok", afterOpen);
    expect(result).toBe("probe ok");
  });

  it("a successful probe closes the circuit", async () => {
    const name = testName();
    const now = 3_000_000;
    for (let i = 0; i < 3; i++) {
      await expect(
        withCircuitBreaker(
          redis,
          name,
          config,
          async () => {
            throw new Error("boom");
          },
          now,
        ),
      ).rejects.toThrow();
    }

    await withCircuitBreaker(redis, name, config, async () => "ok", now + config.openDurationMs);
    expect(await getCircuitState(redis, name)).toBe("closed");

    // Fully recovered — subsequent calls behave normally again.
    const result = await withCircuitBreaker(
      redis,
      name,
      config,
      async () => "back to normal",
      now + config.openDurationMs + 1,
    );
    expect(result).toBe("back to normal");
  });

  it("a failed probe re-opens the circuit", async () => {
    const name = testName();
    const now = 4_000_000;
    for (let i = 0; i < 3; i++) {
      await expect(
        withCircuitBreaker(
          redis,
          name,
          config,
          async () => {
            throw new Error("boom");
          },
          now,
        ),
      ).rejects.toThrow();
    }

    await expect(
      withCircuitBreaker(
        redis,
        name,
        config,
        async () => {
          throw new Error("still broken");
        },
        now + config.openDurationMs,
      ),
    ).rejects.toThrow("still broken");

    expect(await getCircuitState(redis, name)).toBe("open");
  });

  it("only one concurrent caller becomes the probe — every other caller fails fast", async () => {
    const name = testName();
    const now = 5_000_000;
    for (let i = 0; i < 3; i++) {
      await expect(
        withCircuitBreaker(
          redis,
          name,
          config,
          async () => {
            throw new Error("boom");
          },
          now,
        ),
      ).rejects.toThrow();
    }

    const afterOpen = now + config.openDurationMs;
    const attempts = 20;
    let calls = 0;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        withCircuitBreaker(
          redis,
          name,
          config,
          async () => {
            calls++;
            return "probe";
          },
          afterOpen,
        ),
      ),
    );

    // Exactly one caller actually invoked fn (the probe); everyone else
    // got CircuitOpenError without fn running at all.
    expect(calls).toBe(1);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(attempts - 1);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(CircuitOpenError);
    }
  });
});

describe("resetCircuit", () => {
  it("forces the circuit back to closed", async () => {
    const name = testName();
    for (let i = 0; i < 3; i++) {
      await expect(
        withCircuitBreaker(redis, name, config, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow();
    }
    expect(await getCircuitState(redis, name)).toBe("open");

    await resetCircuit(redis, name);
    expect(await getCircuitState(redis, name)).toBe("closed");

    const result = await withCircuitBreaker(redis, name, config, async () => "ok");
    expect(result).toBe("ok");
  });
});

describe("forceOpenCircuit", () => {
  it("opens a circuit that never actually failed, e.g. for manual incident response", async () => {
    const name = testName();
    expect(await getCircuitState(redis, name)).toBe("closed");

    await forceOpenCircuit(redis, name);
    expect(await getCircuitState(redis, name)).toBe("open");

    const fn = vi.fn(async () => "should not run");
    await expect(withCircuitBreaker(redis, name, config, fn)).rejects.toThrow(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("still respects openDurationMs afterward — moves to half_open once it elapses", async () => {
    const name = testName();
    const now = 6_000_000;
    await forceOpenCircuit(redis, name, now);

    await expect(
      withCircuitBreaker(redis, name, config, async () => "too soon", now + 1000),
    ).rejects.toThrow(CircuitOpenError);

    const result = await withCircuitBreaker(
      redis,
      name,
      config,
      async () => "probe",
      now + config.openDurationMs,
    );
    expect(result).toBe("probe");
  });
});
