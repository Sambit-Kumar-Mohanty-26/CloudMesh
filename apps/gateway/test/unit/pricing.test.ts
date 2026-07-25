import { describe, expect, it } from "vitest";
import { computeCostUsd, getModelPricing } from "../../src/lib/pricing.js";

describe("getModelPricing", () => {
  it("returns known pricing for a listed model", () => {
    expect(getModelPricing("gpt-4o")).toEqual({ inputPerMillion: 5, outputPerMillion: 15 });
  });

  it("returns $0 pricing for an unlisted model instead of throwing", () => {
    expect(getModelPricing("llama3.1")).toEqual({ inputPerMillion: 0, outputPerMillion: 0 });
  });
});

describe("computeCostUsd", () => {
  it("matches the design doc's worked example for gpt-4o", () => {
    // 342 prompt tokens + 218 completion tokens, $5/$15 per million.
    const cost = computeCostUsd("gpt-4o", { promptTokens: 342, completionTokens: 218 });
    const expected = (342 / 1_000_000) * 5 + (218 / 1_000_000) * 15;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it("matches the design doc's worked example for claude-sonnet", () => {
    const cost = computeCostUsd("claude-3-5-sonnet-20241022", {
      promptTokens: 342,
      completionTokens: 218,
    });
    const expected = (342 / 1_000_000) * 3 + (218 / 1_000_000) * 15;
    expect(cost).toBeCloseTo(expected, 10);
  });

  it("is $0 for a model not in the pricing table", () => {
    expect(computeCostUsd("llama3.1", { promptTokens: 10_000, completionTokens: 10_000 })).toBe(0);
  });

  it("is $0 for zero usage", () => {
    expect(computeCostUsd("gpt-4o", { promptTokens: 0, completionTokens: 0 })).toBe(0);
  });

  it("rounds to 6 decimal places (matches the DB column's precision)", () => {
    const cost = computeCostUsd("gpt-4o-mini", { promptTokens: 1, completionTokens: 1 });
    const decimals = cost.toString().split(".")[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(6);
  });

  it("scales linearly with token count", () => {
    const small = computeCostUsd("gpt-4o", { promptTokens: 1000, completionTokens: 0 });
    const large = computeCostUsd("gpt-4o", { promptTokens: 10_000, completionTokens: 0 });
    expect(large).toBeCloseTo(small * 10, 8);
  });
});
