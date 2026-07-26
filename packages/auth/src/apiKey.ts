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
 *
 * NOTE: the `codeql[...]` line below is DOCUMENTATION ONLY — GitHub's
 * default JS/TS code scanning does not honor inline suppression comments,
 * and this alert is in fact still open in the Security tab despite it.
 * Clearing it means dismissing it in the GitHub UI as a false positive
 * (which records who dismissed it and why) — a repo action, not a code one.
 */
export function hashApiKey(rawKey: string): string {
  // codeql[js/insufficient-password-hash]
  return createHash("sha256").update(rawKey).digest("hex");
}

export function apiKeyCacheKey(keyHash: string): string {
  return `auth:${keyHash}`;
}
