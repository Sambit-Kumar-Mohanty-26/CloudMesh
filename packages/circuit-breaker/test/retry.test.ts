import { describe, expect, it, vi } from "vitest";
import { computeBackoffDelay, withRetry } from "../src/retry.js";

describe("computeBackoffDelay", () => {
  const config = { maxAttempts: 4, baseDelayMs: 1000 };

  it("matches the spec's 1s/2s/4s/8s progression with zero jitter", () => {
    expect(computeBackoffDelay(1, config, () => 0)).toBe(1000);
    expect(computeBackoffDelay(2, config, () => 0)).toBe(2000);
    expect(computeBackoffDelay(3, config, () => 0)).toBe(4000);
    expect(computeBackoffDelay(4, config, () => 0)).toBe(8000);
  });

  it("adds up to half the exponential delay as jitter", () => {
    // random()=1 is the max jitter case: exponential * 1.5
    expect(computeBackoffDelay(1, config, () => 1)).toBe(1500);
    expect(computeBackoffDelay(2, config, () => 1)).toBe(3000);
    expect(computeBackoffDelay(3, config, () => 1)).toBe(6000);
    expect(computeBackoffDelay(4, config, () => 1)).toBe(12000);
  });

  it("defaults to Math.random when none is injected (just checks it's in range)", () => {
    const delay = computeBackoffDelay(1, config);
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(1500);
  });
});

describe("withRetry", () => {
  const config = { maxAttempts: 4, baseDelayMs: 1000 };

  it("returns immediately on first success, never sleeps", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetry(config, fn, { sleep });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries after failures and succeeds once fn stops failing", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error(`fail ${calls}`);
      return "eventually ok";
    });

    const result = await withRetry(config, fn, { sleep, random: () => 0 });

    expect(result).toBe("eventually ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000); // backoff before attempt 2
    expect(sleep).toHaveBeenNthCalledWith(2, 2000); // backoff before attempt 3
  });

  it("throws the last error after exhausting maxAttempts", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn(async () => {
      throw new Error("always fails");
    });

    await expect(withRetry(config, fn, { sleep })).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(config.maxAttempts);
    expect(sleep).toHaveBeenCalledTimes(config.maxAttempts - 1);
  });

  it("stops immediately when shouldRetry returns false, without sleeping", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    class DoNotRetryError extends Error {}
    const fn = vi.fn(async () => {
      throw new DoNotRetryError("nope");
    });

    await expect(
      withRetry(config, fn, {
        sleep,
        shouldRetry: (err) => !(err instanceof DoNotRetryError),
      }),
    ).rejects.toThrow(DoNotRetryError);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("passes the attempt number to fn", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const seenAttempts: number[] = [];
    const fn = vi.fn(async (attempt: number) => {
      seenAttempts.push(attempt);
      if (attempt < 3) throw new Error("retry me");
      return "done";
    });

    await withRetry(config, fn, { sleep });
    expect(seenAttempts).toEqual([1, 2, 3]);
  });
});
