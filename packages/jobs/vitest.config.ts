import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These are pure unit tests (priority mapping, the registry, progress
    // normalization) — no DB or Redis. The queue/worker/service layers are
    // covered by real integration tests in apps/gateway, where a live
    // Postgres + Redis and a real BullMQ worker are already wired up.
    include: ["test/**/*.test.ts"],
  },
});
