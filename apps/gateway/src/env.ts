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

  // Semantic cache (Phase 6) — org-scoped, per organizations.feature_flags,
  // not a global on/off. See lib/semanticCache.ts.
  SEMANTIC_CACHE_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),
  SEMANTIC_CACHE_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // Request dedup (Phase 6) — in-flight coalescing of identical concurrent
  // requests. DEDUP_LEADER_TTL_SECONDS bounds how long a "leader" has to
  // finish before its claim expires (so a crashed leader doesn't permanently
  // wedge the key); DEDUP_FOLLOWER_WAIT_MS bounds how long a follower waits
  // for the leader's result before giving up and calling the provider
  // itself — see lib/requestDedup.ts.
  DEDUP_LEADER_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  DEDUP_FOLLOWER_WAIT_MS: z.coerce.number().int().positive().default(10_000),

  // Billing (Phase 7) — per-org opt-in via feature_flags.billing_enforcement.
  // BILLING_LOCK_TTL_MS deliberately does NOT default to the design doc's
  // literal "EX 5" — see lib/billing.ts for why a 5s TTL held across a real
  // LLM call would routinely expire mid-request; this lock is only ever
  // held across the brief budget *check*, not the call, so a shorter TTL
  // than "generous enough for an LLM response" is fine and correct here.
  BILLING_LOCK_TTL_MS: z.coerce.number().int().positive().default(5000),
  BILLING_LOCK_RETRIES: z.coerce.number().int().nonnegative().default(3),
  BILLING_LOCK_RETRY_DELAY_MS: z.coerce.number().int().positive().default(50),

  // model:"auto" is substituted with this model once an org's remaining
  // budget drops below 5% — same "auto-only, never an explicit model
  // request" rule as Phase 5's provider fallback. Unset (default) disables
  // the downgrade behavior entirely, even for orgs with billing_enforcement
  // on — it only makes sense once a real "cheap" model is actually
  // configured for this deployment.
  BUDGET_CONSTRAINED_MODEL: z.string().optional(),

  // Outbox poller (Phase 7) — see lib/outbox.ts. No real event bus exists
  // yet (NATS JetStream is Phase 10), so this just moves rows from
  // unpublished to published-via-LogEventPublisher on a timer.
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),

  // Async job queue (Phase 9) — consumed by the separate worker process
  // (src/worker.ts), not the HTTP server. Defaults are the design doc's:
  // 10 concurrent jobs per worker, 5-minute visibility timeout (BullMQ's
  // lockDuration — how long a job may run before an unrenewed lock lets
  // another worker treat it as stalled and pick it up).
  JOB_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  JOB_LOCK_DURATION_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),

  // Event bus (Phase 10). NATS JetStream is the outbox poller's real
  // publish target. Optional on purpose: with it unset the poller falls
  // back to the log publisher, so the gateway still boots and serves
  // traffic with no broker running (a dev convenience — in a real
  // deployment this must be set, or events accumulate unpublished).
  NATS_URL: z.string().optional(),

  // Webhooks (Phase 11) — the delivery worker and dispatch consumer are
  // separate entry points (see src/webhookWorker.ts, src/consumers.ts),
  // both driven off the same Redis queue this URL isn't part of; nothing
  // here is enforced at env-schema level beyond the DB/Redis this service
  // already requires.

  // Email (Phase 11) — Resend, for job completions/budget warnings/API key
  // events. Optional, same "no live credentials in this environment" rule
  // as every other provider: unconfigured means the email subscriber's
  // sends fail individually (logged, swallowed) rather than blocking
  // consumer startup.
  RESEND_API_KEY: z.string().optional(),
  RESEND_BASE_URL: z.string().url().default("https://api.resend.com"),
  RESEND_FROM_EMAIL: z.string().default("alerts@cloudmesh.dev"),

  // Observability (Phase 12) — how often server.ts polls each provider's
  // circuit state (a Redis read, via getCircuitState) into the
  // cloudmesh_circuit_breaker_state gauge. Reactive updates aren't enough
  // on their own: a circuit that trips and later half-opens/closes without
  // any new request touching this specific poll path would otherwise leave
  // the gauge stuck at its last-observed value.
  CIRCUIT_METRICS_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
});

export const env = schema.parse(process.env);
export type Env = typeof env;
