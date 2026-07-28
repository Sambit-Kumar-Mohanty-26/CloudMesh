import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      APP_DATABASE_URL: "postgresql://cloudmesh_app:cloudmesh_app@localhost:55432/cloudmesh",
      DATABASE_URL: "postgresql://cloudmesh:cloudmesh@localhost:55432/cloudmesh",
      REDIS_URL: "redis://localhost:6379",
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Same reasoning as every other workspace's config: integration tests
    // share one real Postgres/Redis and reset it in beforeEach.
    fileParallelism: false,
  },
});
