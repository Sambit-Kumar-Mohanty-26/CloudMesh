import { createHash, randomBytes } from "node:crypto";

const PREFIX = "cm_live_";

export function generateApiKey(): { rawKey: string; keyPrefix: string } {
  const rawKey = `${PREFIX}${randomBytes(24).toString("base64url")}`;
  return { rawKey, keyPrefix: rawKey.slice(0, 12) };
}

/**
 * rawKey is a 24-byte cryptographically random token (see generateApiKey
 * above), not a low-entropy human password. SHA-256 is the correct
 * primitive for a high-entropy secret: deterministic, so
 * lookup_api_key_by_hash() can index and look up in O(1) instead of
 * bcrypt-comparing against every stored hash. Switching this to bcrypt
 * would be a regression, not a fix.
 */
export function hashApiKey(rawKey: string): string {
  // codeql[js/insufficient-password-hash]
  return createHash("sha256").update(rawKey).digest("hex");
}

export function apiKeyCacheKey(keyHash: string): string {
  return `auth:${keyHash}`;
}
