import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      NATS_URL: "nats://localhost:4222",
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Integration tests here share one real NATS server and create/destroy
    // streams in setup — same reasoning as the other workspaces' configs.
    fileParallelism: false,
  },
});
