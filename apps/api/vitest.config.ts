import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      APP_DATABASE_URL: "postgresql://cloudmesh_app:cloudmesh_app@localhost:55432/cloudmesh",
      DATABASE_URL: "postgresql://cloudmesh:cloudmesh@localhost:55432/cloudmesh",
      REDIS_URL: "redis://localhost:6379",
      PORT: "3999",
      JWT_SECRET: "test-only-secret-do-not-use-anywhere-else-32chars-min",
      JWT_SECRET_PREVIOUS: "",
      BCRYPT_COST: "10", // lower than prod default — tests run this a lot
    },
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Integration tests share ONE external Postgres + Redis instance and
    // each resets it in beforeEach (TRUNCATE + FLUSHDB). Running test
    // files concurrently caused real Postgres deadlocks between files'
    // TRUNCATEs and silent cross-file data pollution (one file's reset
    // wiping another's mid-test — flaky, wrong-looking failures, not
    // real bugs). If this suite grows large enough for sequential runs to
    // be painfully slow, the fix is per-worker Postgres schemas / Redis
    // key prefixes, not turning this back on.
    fileParallelism: false,
  },
});
