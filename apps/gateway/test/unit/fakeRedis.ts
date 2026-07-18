import type { Redis } from "ioredis";

/**
 * A minimal in-memory stand-in for ioredis, implementing just the subset
 * (get/set) that lib/modelsCache.ts uses. Lets adapter unit tests prove the
 * caching LOGIC is correct (second call doesn't re-hit the mocked HTTP
 * endpoint) without needing a real Redis server — that would blur unit
 * tests into integration tests for no benefit, since the thing being
 * tested here is "did we check the cache before fetching," not Redis
 * itself.
 */
export function createFakeRedis(): Redis {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
      return "OK";
    },
  } as unknown as Redis;
}
