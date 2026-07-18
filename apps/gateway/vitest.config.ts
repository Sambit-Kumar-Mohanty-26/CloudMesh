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
    },
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Same reasoning as apps/api/vitest.config.ts: integration tests share
    // one real Postgres/Redis and reset it in beforeEach.
    fileParallelism: false,
  },
});
