import { describe, expect, it } from "vitest";
import { normalizeProgress, jobProgressChannel } from "../src/progress.js";
import {
  DEFAULT_PRIORITY,
  JOB_PRIORITIES,
  JOB_QUEUE_NAME,
  JOB_QUEUE_PREFIX,
  JobRegistry,
  UnknownJobTypeError,
  isJobPriorityName,
  toPriorityValue,
} from "../src/types.js";

describe("job priorities", () => {
  it("matches the design doc's exact scale", () => {
    expect(JOB_PRIORITIES).toEqual({ CRITICAL: 1, HIGH: 5, NORMAL: 10, LOW: 20 });
  });

  it("orders CRITICAL ahead of LOW (lower number = higher priority)", () => {
    expect(JOB_PRIORITIES.CRITICAL).toBeLessThan(JOB_PRIORITIES.HIGH);
    expect(JOB_PRIORITIES.HIGH).toBeLessThan(JOB_PRIORITIES.NORMAL);
    expect(JOB_PRIORITIES.NORMAL).toBeLessThan(JOB_PRIORITIES.LOW);
  });

  it("defaults to NORMAL", () => {
    expect(DEFAULT_PRIORITY).toBe("NORMAL");
    expect(toPriorityValue(undefined)).toBe(JOB_PRIORITIES.NORMAL);
  });

  it("resolves each valid name to its number", () => {
    expect(toPriorityValue("CRITICAL")).toBe(1);
    expect(toPriorityValue("HIGH")).toBe(5);
    expect(toPriorityValue("NORMAL")).toBe(10);
    expect(toPriorityValue("LOW")).toBe(20);
  });

  it("falls back to NORMAL for hostile or malformed input rather than throwing", () => {
    expect(toPriorityValue("URGENT!!")).toBe(10);
    expect(toPriorityValue(null)).toBe(10);
    expect(toPriorityValue(1)).toBe(10);
    expect(toPriorityValue({})).toBe(10);
    expect(toPriorityValue([])).toBe(10);
  });

  it("isJobPriorityName rejects non-strings without throwing", () => {
    expect(isJobPriorityName("HIGH")).toBe(true);
    expect(isJobPriorityName("nope")).toBe(false);
    expect(isJobPriorityName(undefined)).toBe(false);
    expect(isJobPriorityName(null)).toBe(false);
    expect(isJobPriorityName(42)).toBe(false);
  });
});

describe("queue naming", () => {
  it("splits into prefix + name so the Redis keyspace is still cloudmesh:jobs", () => {
    // BullMQ forbids ':' inside a queue name, so the design doc's literal
    // "cloudmesh:jobs" has to be expressed as prefix + name — the resulting
    // Redis keys are identical.
    expect(JOB_QUEUE_NAME).not.toContain(":");
    expect(`${JOB_QUEUE_PREFIX}:${JOB_QUEUE_NAME}`).toBe("cloudmesh:jobs");
  });
});

describe("JobRegistry", () => {
  const handler = {
    type: "test_job",
    parsePayload: (raw: unknown) => raw,
    run: async () => "done",
  };

  it("registers and retrieves a handler by type", () => {
    const registry = new JobRegistry().register(handler);
    expect(registry.get("test_job").type).toBe("test_job");
    expect(registry.has("test_job")).toBe(true);
  });

  it("throws UnknownJobTypeError for an unregistered type", () => {
    const registry = new JobRegistry();
    expect(() => registry.get("nope")).toThrow(UnknownJobTypeError);
    expect(registry.has("nope")).toBe(false);
  });

  it("lists registered types", () => {
    const registry = new JobRegistry()
      .register(handler)
      .register({ ...handler, type: "other_job" });
    expect(registry.types().sort()).toEqual(["other_job", "test_job"]);
  });

  it("a later registration replaces an earlier one of the same type", () => {
    const registry = new JobRegistry()
      .register(handler)
      .register({ ...handler, run: async () => "replaced" });
    expect(registry.types()).toEqual(["test_job"]);
  });
});

describe("progress", () => {
  it("channel is keyed by the job record id, matching the design doc", () => {
    expect(jobProgressChannel("abc-123")).toBe("job:abc-123:progress");
  });

  it("clamps out-of-range values to 0-100", () => {
    expect(normalizeProgress(-5)).toBe(0);
    expect(normalizeProgress(150)).toBe(100);
    expect(normalizeProgress(0)).toBe(0);
    expect(normalizeProgress(100)).toBe(100);
  });

  it("floors fractional progress to an integer for the INTEGER column", () => {
    expect(normalizeProgress(33.9)).toBe(33);
    expect(normalizeProgress(66.4)).toBe(66);
  });

  it("treats NaN/Infinity as 0 rather than corrupting the row", () => {
    expect(normalizeProgress(Number.NaN)).toBe(0);
    expect(normalizeProgress(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeProgress(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
