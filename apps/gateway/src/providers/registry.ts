import type { LLMProvider, ModelInfo } from "./types.js";

export interface ResolvedModel {
  provider: LLMProvider;
  providerModel: string;
}

export interface ModelRegistry {
  resolve(modelName: string): ResolvedModel | undefined;
  listModels(): Promise<ModelInfo[]>;
}

export interface ProviderRule {
  provider: LLMProvider;
  matches: (model: string) => boolean;
}

/**
 * Routes by model-name prefix rather than a hardcoded per-model allowlist.
 * Provider catalogs change too often — and this project's own knowledge of
 * "current" model IDs goes stale the moment it's written — for an enum to
 * stay accurate. A model string that doesn't obviously belong to any known
 * provider still gets routed (to whichever rule matches, typically a
 * catch-all) and forwarded to that provider's real API; an actually-invalid
 * name is rejected THERE (surfaced here as a 502 ProviderError), not
 * blocked by CloudMesh guessing wrong about what "valid" means today.
 *
 * `rules` order matters — first match wins. A catch-all rule (`() => true`)
 * must be last if present; see providers/index.ts for how it's built.
 *
 * `listModels()` (used by GET /v1/models) is advisory/discovery only — it
 * is not consulted by `resolve()` and being incomplete or slightly stale
 * doesn't break routing.
 */
export function createModelRegistry(rules: ProviderRule[], defaultModel: string): ModelRegistry {
  return {
    resolve(modelName: string): ResolvedModel | undefined {
      const target = modelName === "auto" ? defaultModel : modelName;
      const rule = rules.find((r) => r.matches(target));
      return rule ? { provider: rule.provider, providerModel: target } : undefined;
    },
    async listModels(): Promise<ModelInfo[]> {
      const seen = new Set<LLMProvider>();
      const providers = rules.map((r) => r.provider).filter((p) => !seen.has(p) && seen.add(p));
      // One provider's models-list endpoint being down/unconfigured must
      // not blank out discovery for every other provider.
      const results = await Promise.allSettled(providers.map((p) => p.models()));
      return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    },
  };
}
