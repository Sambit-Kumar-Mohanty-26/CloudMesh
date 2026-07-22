import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      REDIS_URL: "redis://localhost:6379",
    },
    testTimeout: 15_000,
    // Same reasoning as packages/rate-limiter: every test uses its own
    // randomly-suffixed identifier, so files can run in parallel against
    // the same real Redis without needing a shared reset.
  },
});
