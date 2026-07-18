import type { Redis } from "ioredis";
import type { ModelInfo } from "../providers/types.js";

const TTL_SECONDS = 60 * 60; // 1 hour — a live catalog doesn't need per-request freshness

/**
 * Caches a provider's live model listing in Redis so GET /v1/models doesn't
 * hit every provider's API on every call. Keyed per-provider so one
 * provider's cache expiring/missing doesn't affect the others.
 */
export async function cachedModels(
  redis: Redis,
  provider: string,
  fetchLive: () => Promise<ModelInfo[]>,
): Promise<ModelInfo[]> {
  const key = `models:${provider}`;
  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached) as ModelInfo[];
  }

  const models = await fetchLive();
  await redis.set(key, JSON.stringify(models), "EX", TTL_SECONDS);
  return models;
}
