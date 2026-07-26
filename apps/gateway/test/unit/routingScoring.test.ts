import { describe, expect, it } from "vitest";
import type { ProviderStats } from "../../src/lib/providerStats.js";
import {
  computeRoutingScore,
  DEFAULT_ROUTING_PRESET,
  isRoutingPresetName,
  ROUTING_PRESETS,
} from "../../src/lib/routingScoring.js";

function stats(overrides: Partial<ProviderStats> = {}): ProviderStats {
  return {
    sampleCount: 10,
    p50Ms: 200,
    p99Ms: 400,
    successRate: 0.99,
    rpmCurrent: 5,
    ...overrides,
  };
}

describe("ROUTING_PRESETS", () => {
  it("matches the design doc's exact three named presets and weights", () => {
    expect(ROUTING_PRESETS.cost_optimized.weights).toEqual({
      latency: 0.2,
      cost: 0.6,
      reliability: 0.2,
    });
    expect(ROUTING_PRESETS.latency_optimized.weights).toEqual({
      latency: 0.6,
      cost: 0.1,
      reliability: 0.3,
    });
    expect(ROUTING_PRESETS.balanced.weights).toEqual({ latency: 0.3, cost: 0.4, reliability: 0.3 });
  });

  it("defaults to cost_optimized, matching the design doc", () => {
    expect(DEFAULT_ROUTING_PRESET).toBe("cost_optimized");
  });
});

describe("isRoutingPresetName", () => {
  it("accepts each real preset name", () => {
    for (const name of Object.keys(ROUTING_PRESETS)) {
      expect(isRoutingPresetName(name)).toBe(true);
    }
  });

  it("rejects an unknown string", () => {
    expect(isRoutingPresetName("made_up_preset")).toBe(false);
  });

  it("rejects non-string values without throwing", () => {
    expect(isRoutingPresetName(undefined)).toBe(false);
    expect(isRoutingPresetName(null)).toBe(false);
    expect(isRoutingPresetName(42)).toBe(false);
    expect(isRoutingPresetName({})).toBe(false);
  });
});

describe("computeRoutingScore", () => {
  it("implements the design doc's exact formula", () => {
    const s = stats({ sampleCount: 10, p99Ms: 500, successRate: 0.9 });
    const weights = { latency: 0.2, cost: 0.6, reliability: 0.2 };
    const costPer1k = 0.01;

    const score = computeRoutingScore(s, costPer1k, weights);
    const expected = (1 / 500) * 0.2 + (1 / 0.01) * 0.6 + 0.9 * 0.2;
    expect(score).toBeCloseTo(expected, 10);
  });

  it("a lower-latency provider scores higher, all else equal", () => {
    const weights = ROUTING_PRESETS.latency_optimized.weights;
    const fast = computeRoutingScore(stats({ p99Ms: 100 }), 0.01, weights);
    const slow = computeRoutingScore(stats({ p99Ms: 1000 }), 0.01, weights);
    expect(fast).toBeGreaterThan(slow);
  });

  it("a cheaper provider scores higher under cost_optimized, all else equal", () => {
    const weights = ROUTING_PRESETS.cost_optimized.weights;
    const cheap = computeRoutingScore(stats(), 0.001, weights);
    const expensive = computeRoutingScore(stats(), 0.1, weights);
    expect(cheap).toBeGreaterThan(expensive);
  });

  it("a more reliable provider scores higher, all else equal", () => {
    const weights = ROUTING_PRESETS.balanced.weights;
    const reliable = computeRoutingScore(stats({ successRate: 0.999 }), 0.01, weights);
    const flaky = computeRoutingScore(stats({ successRate: 0.5 }), 0.01, weights);
    expect(reliable).toBeGreaterThan(flaky);
  });

  it("a free ($0) provider scores very high on cost but stays finite", () => {
    const weights = ROUTING_PRESETS.cost_optimized.weights;
    const score = computeRoutingScore(stats(), 0, weights);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(computeRoutingScore(stats(), 0.01, weights));
  });

  it("a genuinely 0ms-latency reading stays finite, not Infinity/NaN", () => {
    const weights = ROUTING_PRESETS.latency_optimized.weights;
    const score = computeRoutingScore(stats({ p99Ms: 0 }), 0.01, weights);
    expect(Number.isFinite(score)).toBe(true);
  });

  it("zero samples uses a neutral assumed reading, not a 0ms/0-cost extreme", () => {
    const weights = ROUTING_PRESETS.balanced.weights;
    const unknown = computeRoutingScore(
      stats({ sampleCount: 0, p99Ms: 0, successRate: 0 }),
      0.01,
      weights,
    );
    const knownGood = computeRoutingScore(
      stats({ sampleCount: 10, p99Ms: 50, successRate: 1 }),
      0.01,
      weights,
    );
    const knownBad = computeRoutingScore(
      stats({ sampleCount: 10, p99Ms: 5000, successRate: 0.1 }),
      0.01,
      weights,
    );
    // An unknown provider should be plausibly "middle of the pack" — better
    // than something with actually-measured bad stats, worse than something
    // with actually-measured great stats — not an outlier in either
    // direction just because it has no data yet.
    expect(unknown).toBeGreaterThan(knownBad);
    expect(unknown).toBeLessThan(knownGood);
  });

  it("is deterministic — same inputs always produce the same score", () => {
    const weights = ROUTING_PRESETS.cost_optimized.weights;
    const a = computeRoutingScore(stats(), 0.02, weights);
    const b = computeRoutingScore(stats(), 0.02, weights);
    expect(a).toBe(b);
  });
});
