import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      APP_DATABASE_URL: "postgresql://cloudmesh_app:cloudmesh_app@localhost:55432/cloudmesh",
      DATABASE_URL: "postgresql://cloudmesh:cloudmesh@localhost:55432/cloudmesh",
      REDIS_URL: "redis://localhost:6379",
      PORT: "3999",
      ENABLE_MOCK_PROVIDER: "true",
      IDEMPOTENCY_TTL_SECONDS: "86400",
      OPENAI_BASE_URL: "https://api.openai.test",
      ANTHROPIC_BASE_URL: "https://api.anthropic.test",
      GEMINI_BASE_URL: "https://generativelanguage.test",
      OLLAMA_BASE_URL: "http://ollama.test",
      // Retry mechanics (backoff formula, jitter, attempt counting) are
      // already precisely unit-tested with injected sleep in
      // packages/circuit-breaker — these integration tests only need to
      // prove the wiring, not real timing. Without this, tests that hit a
      // genuine failure path (unconfigured provider, Ollama catch-all)
      // burn ~8-10 real seconds each on exponential backoff.
      RETRY_MAX_ATTEMPTS: "2",
      RETRY_BASE_DELAY_MS: "10",
      // Small enough that resilience tests can trip/recover a circuit in
      // a handful of requests and a short real sleep, not dozens/minutes.
      CIRCUIT_FAILURE_THRESHOLD: "2",
      CIRCUIT_OPEN_DURATION_MS: "200",
      // Lets "auto" fall back to the always-succeeding mock provider once
      // DEFAULT_MODEL's (gpt-4o-mini, unconfigured in tests) circuit opens.
      AUTO_FALLBACK_MODELS: "mock-echo",
    },
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Same reasoning as apps/api/vitest.config.ts: integration tests share
    // one real Postgres/Redis and reset it in beforeEach.
    fileParallelism: false,
  },
});
