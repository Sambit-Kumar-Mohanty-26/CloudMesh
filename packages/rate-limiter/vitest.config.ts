import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      REDIS_URL: "redis://localhost:6379",
    },
    testTimeout: 15_000,
    // Unlike apps/api and apps/gateway, these tests don't share global
    // state to reset (no Postgres, no FLUSHDB) — every test generates its
    // own randomly-suffixed Redis key, so files can safely run in parallel.
  },
});
