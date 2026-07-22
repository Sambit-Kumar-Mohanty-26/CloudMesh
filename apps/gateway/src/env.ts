import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_DATABASE_URL: z.string().url(),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3001),

  // Provider credentials are optional: this gateway must be able to boot
  // (and its non-provider-specific tests must run) without any real LLM
  // API keys configured. An adapter invoked without its key fails that one
  // request with a clear error, not a startup crash.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com"),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().url().default("https://api.anthropic.com"),
  ANTHROPIC_VERSION: z.string().default("2023-06-01"),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_BASE_URL: z.string().url().default("https://generativelanguage.googleapis.com"),

  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),

  // Registers a canned, no-network "mock" provider under model name
  // "mock-echo" — lets the full gateway pipeline (auth, idempotency,
  // streaming, error handling) be exercised end-to-end without any real
  // provider credentials. Never enabled by a default in production; must
  // be turned on explicitly.
  ENABLE_MOCK_PROVIDER: z.coerce.boolean().default(false),

  IDEMPOTENCY_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24),

  // What model:"auto" resolves to until a real Intelligent Routing Engine
  // exists (not yet built as of Phase 5). Must name a model some enabled
  // provider actually serves.
  DEFAULT_MODEL: z.string().default("gpt-4o-mini"),

  // Comma-separated models tried, in order, if DEFAULT_MODEL's provider
  // circuit is open — only applies to "auto"; an explicit model request
  // never gets silently swapped for a different model. Empty by default:
  // fallback is opt-in, since it only makes sense once more than one
  // provider is actually configured.
  AUTO_FALLBACK_MODELS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
    ),

  // Circuit breaker (Phase 5) — per provider, not global.
  CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  CIRCUIT_FAILURE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  CIRCUIT_OPEN_DURATION_MS: z.coerce.number().int().positive().default(30_000),

  // Retry with exponential backoff + jitter (Phase 5), applied before the
  // circuit breaker ever records a failure — see lib/resilience.ts.
  RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(1000),
});

export const env = schema.parse(process.env);
export type Env = typeof env;
