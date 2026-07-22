import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

export function createTestRedis(): Redis {
  return new Redis(process.env.REDIS_URL!);
}

export function testName(): string {
  return `test-${randomUUID()}`;
}
