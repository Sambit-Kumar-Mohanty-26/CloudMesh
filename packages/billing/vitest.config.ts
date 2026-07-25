import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      APP_DATABASE_URL: "postgresql://cloudmesh_app:cloudmesh_app@localhost:55432/cloudmesh",
      DATABASE_URL: "postgresql://cloudmesh:cloudmesh@localhost:55432/cloudmesh",
    },
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Same reasoning as apps/api's and apps/gateway's vitest.config.ts:
    // integration tests share one real Postgres and reset it in beforeEach.
    fileParallelism: false,
  },
});
