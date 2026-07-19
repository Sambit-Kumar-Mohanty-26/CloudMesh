import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

export function createTestRedis(): Redis {
  return new Redis(process.env.REDIS_URL!);
}

/** A fresh, collision-proof identifier per test — this is what lets every
 *  test file in this package run in parallel against the same real Redis
 *  instance without needing a shared FLUSHDB/beforeEach reset. */
export function testIdentifier(): string {
  return `test-${randomUUID()}`;
}
