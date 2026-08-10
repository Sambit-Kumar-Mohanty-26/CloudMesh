import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Authenticated encryption for the dashboard's own session cookie.
 *
 * Phase 13 shipped this cookie as plaintext JSON, with the documented
 * reasoning that it's httpOnly and every value inside is re-verified by
 * apps/api on each call (a tampered access token just 401s), so tampering
 * could only break your own session, never escalate privilege. That
 * reasoning still holds — this is defense in depth, not a fix for a known
 * bypass:
 *
 *   - The refresh token stops sitting in cleartext anywhere it could be
 *     read at rest (a disk-backed browser profile, a proxy that logs
 *     request headers, a crash dump, a shared machine).
 *   - Tampering now fails closed at the dashboard boundary, before any
 *     request is proxied to apps/api at all, instead of being detected one
 *     hop later.
 *
 * AES-256-GCM: the GCM auth tag means a modified ciphertext fails to
 * decrypt rather than silently yielding attacker-chosen plaintext, so this
 * gives integrity as well as confidentiality — a plain `createCipheriv`
 * mode like CBC would give neither on its own.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, the size GCM is specified for
const AUTH_TAG_LENGTH = 16;
const VERSION = "v1";

/**
 * The signing key. Derived by SHA-256 so any sufficiently long secret
 * yields the exact 32 bytes AES-256 requires, rather than forcing the
 * operator to supply exactly-32-character input.
 *
 * Read lazily, not at module load: importing this file must not crash a
 * build or a unit test that never touches a session. It throws only when a
 * session is actually read or written without a configured secret.
 */
function getKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "SESSION_SECRET must be set to at least 32 characters to encrypt the dashboard session cookie. " +
        "Generate one with: openssl rand -base64 48",
    );
  }
  return createHash("sha256").update(secret).digest();
}

/** Returns `v1.<iv>.<authTag>.<ciphertext>`, all base64url. */
export function encryptSession(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Returns undefined for anything that isn't a valid, untampered token —
 * wrong version, malformed shape, bad auth tag, or a value encrypted under
 * a different secret. Callers treat that identically to "no session", so a
 * rotated SESSION_SECRET logs everyone out rather than erroring.
 *
 * Never throws on attacker-controlled input; the only throw path is a
 * missing/short SESSION_SECRET, which is an operator error, not user input.
 */
export function decryptSession(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 4) return undefined;

  const [version, ivB64, authTagB64, ciphertextB64] = parts;

  // Constant-time compare on the version tag. It's not secret, but there's
  // no reason to branch on attacker-supplied bytes in variable time.
  const versionBuf = Buffer.from(version, "utf8");
  const expectedBuf = Buffer.from(VERSION, "utf8");
  if (versionBuf.length !== expectedBuf.length || !timingSafeEqual(versionBuf, expectedBuf)) {
    return undefined;
  }

  try {
    const iv = Buffer.from(ivB64, "base64url");
    const authTag = Buffer.from(authTagB64, "base64url");
    const ciphertext = Buffer.from(ciphertextB64, "base64url");

    // Reject wrong-sized IV/tag up front: createDecipheriv would throw on
    // these anyway, but failing here keeps the thrown-vs-returned contract
    // obvious rather than relying on the catch below.
    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) return undefined;

    const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Bad auth tag (tampered or wrong key) lands here. Deliberately opaque:
    // the caller only learns "no valid session", never why.
    return undefined;
  }
}
