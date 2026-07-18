import type { Redis } from "ioredis";
import type { Env } from "../env.js";
import { AnthropicAdapter } from "./anthropic.js";
import { GeminiAdapter } from "./gemini.js";
import { MockProvider } from "./mock.js";
import { OllamaAdapter } from "./ollama.js";
import { OpenAIAdapter } from "./openai.js";
import { createModelRegistry, type ModelRegistry, type ProviderRule } from "./registry.js";

export function buildRegistry(env: Env, redis: Redis): ModelRegistry {
  const openai = new OpenAIAdapter({
    apiKey: env.OPENAI_API_KEY,
    baseUrl: env.OPENAI_BASE_URL,
    redis,
  });
  const anthropic = new AnthropicAdapter({
    apiKey: env.ANTHROPIC_API_KEY,
    baseUrl: env.ANTHROPIC_BASE_URL,
    version: env.ANTHROPIC_VERSION,
    redis,
  });
  const gemini = new GeminiAdapter({
    apiKey: env.GEMINI_API_KEY,
    baseUrl: env.GEMINI_BASE_URL,
    redis,
  });
  const ollama = new OllamaAdapter({ baseUrl: env.OLLAMA_BASE_URL, redis });

  const rules: ProviderRule[] = [
    { provider: openai, matches: (m) => /^(gpt-|o1|o3|o4)/.test(m) },
    { provider: anthropic, matches: (m) => m.startsWith("claude-") },
    { provider: gemini, matches: (m) => m.startsWith("gemini-") },
  ];

  if (env.ENABLE_MOCK_PROVIDER) {
    rules.push({ provider: new MockProvider(), matches: (m) => m.startsWith("mock-") });
  }

  // Ollama model names are whatever's installed locally (llama3.1, mistral,
  // phi3, ...) — no shared prefix to match on, so it's the catch-all and
  // MUST stay last: every rule above it is checked first.
  rules.push({ provider: ollama, matches: () => true });

  return createModelRegistry(rules, env.DEFAULT_MODEL);
}

export type { ModelRegistry, ProviderRule, ResolvedModel } from "./registry.js";
export * from "./types.js";
