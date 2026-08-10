import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "./env";
import { decryptSession, encryptSession } from "./sessionCrypto";

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; role: string; orgId: string };
}

/**
 * This is a BFF (backend-for-frontend), not a browser talking to apps/api
 * directly — deliberately. apps/api's refresh cookie is `sameSite: strict`
 * and scoped to its own origin, so a cross-origin browser fetch from the
 * dashboard's own port could never send it anyway. Every Server Component
 * and Route Handler here calls apps/api server-to-server instead, using
 * this cookie (on the DASHBOARD's own origin) to carry the session across
 * page loads.
 *
 * The cookie is httpOnly (never readable by browser JS — an XSS bug can't
 * exfiltrate it via document.cookie) AND encrypted with AES-256-GCM (see
 * ./sessionCrypto). Phase 13 originally shipped it as plaintext JSON, on
 * the reasoning that every value inside is independently re-verified by
 * apps/api on each call — a tampered accessToken just 401s, so tampering
 * could break your own session but never forge access to another org.
 * That reasoning was sound and still holds; the encryption is defense in
 * depth on top of it, keeping the refresh token out of cleartext at rest
 * and failing tampering closed at this boundary rather than one hop later.
 */
export async function getSession(): Promise<Session | undefined> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!raw) return undefined;

  const plaintext = decryptSession(raw);
  if (!plaintext) return undefined;

  try {
    return JSON.parse(plaintext) as Session;
  } catch {
    return undefined;
  }
}

/** Only callable from a Route Handler or Server Action — Next.js throws if
 *  called during a Server Component's render, since cookies can't be
 *  mutated mid-render. */
export async function setSession(session: Session): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, encryptSession(JSON.stringify(session)), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
