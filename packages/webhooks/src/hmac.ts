import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** A high-entropy secret, generated server-side — same convention as an API
 *  key's raw value (packages/auth/src/apiKey.ts): never chosen by the org,
 *  shown exactly once at creation, and unrecoverable afterward (this one is
 *  stored in plaintext rather than hashed, since HMAC signing needs to
 *  reproduce it on every delivery — see the model comment in
 *  schema.prisma — but the org still only ever sees it once). */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/** The design doc's exact signing scheme: `HMAC-SHA256(payload, secret)`,
 *  sent as `X-CloudMesh-Signature`. `payload` MUST be the exact raw bytes
 *  the receiver will verify against — signing a re-serialized
 *  JSON.stringify(JSON.parse(body)) can differ byte-for-byte (key order,
 *  whitespace) from what was actually sent, the same lesson Phase 7's
 *  Stripe adapter documents for the opposite (verifying) direction. */
export function signWebhookPayload(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Constant-time comparison — the client-side half of the design doc's
 *  verification snippet, provided here so it's exercised by this
 *  package's own tests (sign with a known secret, verify the same
 *  signature) rather than only documented as something a client does. A
 *  length mismatch would throw inside `timingSafeEqual`, so that's checked
 *  first rather than let a malformed signature crash instead of cleanly
 *  failing. */
export function verifyWebhookSignature(
  rawBody: string,
  secret: string,
  signature: string,
): boolean {
  const expected = signWebhookPayload(rawBody, secret);
  const expectedBuf = Buffer.from(expected, "hex");
  let actualBuf: Buffer;
  try {
    actualBuf = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}
