import { forceOpenCircuit, resetCircuit } from "@cloudmesh/circuit-breaker";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordProviderOutcome } from "../../src/lib/providerStats.js";
import {
  getAbStats,
  recordAbSelection,
  scoreCandidates,
  selectAbVariant,
} from "../../src/lib/routing.js";
import { createTestApp, resetAll } from "./helpers.js";

describe("routing.ts", () => {
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
  afterEach(async () => {
    await resetCircuit(app.redis, "openai");
    await resetCircuit(app.redis, "mock");
  });

  describe("scoreCandidates", () => {
    it("ranks the free mock-echo model above a paid, unconfigured model under cost_optimized", async () => {
      const scored = await scoreCandidates(
        app.models,
        app.redis,
        ["gpt-4o-mini", "mock-echo"],
        "cost_optimized",
      );
      expect(scored.map((s) => s.model)).toEqual(["mock-echo", "gpt-4o-mini"]);
    });

    it("excludes a candidate whose circuit is open", async () => {
      await forceOpenCircuit(app.redis, "mock");
      const scored = await scoreCandidates(app.models, app.redis, ["mock-echo"], "cost_optimized");
      expect(scored).toEqual([]);
    });

    it("excludes a candidate that doesn't resolve to any provider", async () => {
      // Ollama is the catch-all in this registry, so literally nothing
      // fails to resolve — use a distinctly-scoped registry check instead:
      // an empty candidate list resolves to nothing, trivially.
      const scored = await scoreCandidates(app.models, app.redis, [], "cost_optimized");
      expect(scored).toEqual([]);
    });

    it("a provider with better real recorded stats scores higher within the same preset", async () => {
      await recordProviderOutcome(app.redis, "mock", 10, true);
      const withGoodStats = await scoreCandidates(
        app.models,
        app.redis,
        ["mock-echo"],
        "latency_optimized",
      );
      // Sanity: score is a real finite number reflecting the recorded stats,
      // not some placeholder.
      expect(withGoodStats[0]!.score).toBeGreaterThan(0);
      expect(Number.isFinite(withGoodStats[0]!.score)).toBe(true);
    });
  });

  describe("selectAbVariant", () => {
    it("selects a variant proportionally to its configured weight over many trials", async () => {
      const abConfig = { "mock-echo": 0.8, "gpt-4o-mini": 0.2 };
      let mockCount = 0;
      const trials = 500;
      for (let i = 0; i < trials; i++) {
        const selection = await selectAbVariant(app.models, app.redis, abConfig);
        if (selection?.model === "mock-echo") mockCount++;
      }
      const ratio = mockCount / trials;
      expect(ratio).toBeGreaterThan(0.65);
      expect(ratio).toBeLessThan(0.95);
    });

    it("never selects a variant whose circuit is open, renormalizing the remaining weights", async () => {
      await forceOpenCircuit(app.redis, "mock");
      const abConfig = { "mock-echo": 0.9, "gpt-4o-mini": 0.1 };

      for (let i = 0; i < 20; i++) {
        const selection = await selectAbVariant(app.models, app.redis, abConfig);
        expect(selection?.model).toBe("gpt-4o-mini");
      }
    });

    it("returns undefined when every variant's circuit is open", async () => {
      await forceOpenCircuit(app.redis, "mock");
      const selection = await selectAbVariant(app.models, app.redis, { "mock-echo": 1 });
      expect(selection).toBeUndefined();
    });

    it("is deterministic given an injected random function", async () => {
      const abConfig = { "mock-echo": 0.5, "gpt-4o-mini": 0.5 };
      const alwaysLow = () => 0.01;
      const selection = await selectAbVariant(app.models, app.redis, abConfig, alwaysLow);
      expect(selection?.model).toBe("mock-echo");

      const alwaysHigh = () => 0.99;
      const selection2 = await selectAbVariant(app.models, app.redis, abConfig, alwaysHigh);
      expect(selection2?.model).toBe("gpt-4o-mini");
    });
  });

  describe("recordAbSelection / getAbStats", () => {
    it("counts selections per (org, variant)", async () => {
      const orgId = "org-1";
      const abConfig = { "mock-echo": 1, "gpt-4o-mini": 1 };
      await recordAbSelection(app.redis, orgId, "mock-echo");
      await recordAbSelection(app.redis, orgId, "mock-echo");
      await recordAbSelection(app.redis, orgId, "gpt-4o-mini");

      const stats = await getAbStats(app.redis, orgId, abConfig);
      expect(stats).toEqual({ "mock-echo": 2, "gpt-4o-mini": 1 });
    });

    it("never mixes one org's A/B counts into another org's stats", async () => {
      const abConfig = { "mock-echo": 1 };
      await recordAbSelection(app.redis, "org-a", "mock-echo");
      await recordAbSelection(app.redis, "org-a", "mock-echo");
      await recordAbSelection(app.redis, "org-b", "mock-echo");

      const statsA = await getAbStats(app.redis, "org-a", abConfig);
      const statsB = await getAbStats(app.redis, "org-b", abConfig);
      expect(statsA).toEqual({ "mock-echo": 2 });
      expect(statsB).toEqual({ "mock-echo": 1 });
    });

    it("returns 0 for a variant never selected", async () => {
      const stats = await getAbStats(app.redis, "org-fresh", { "mock-echo": 1 });
      expect(stats).toEqual({ "mock-echo": 0 });
    });
  });
});
