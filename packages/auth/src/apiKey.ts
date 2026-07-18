import { createHash, randomBytes } from "node:crypto";

const PREFIX = "cm_live_";

export function generateApiKey(): { rawKey: string; keyPrefix: string } {
  const rawKey = `${PREFIX}${randomBytes(24).toString("base64url")}`;
  return { rawKey, keyPrefix: rawKey.slice(0, 12) };
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function apiKeyCacheKey(keyHash: string): string {
  return `auth:${keyHash}`;
}
