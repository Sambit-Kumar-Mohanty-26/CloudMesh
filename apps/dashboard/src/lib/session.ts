import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "./env";

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
 * Deliberately NOT signed/encrypted. It's httpOnly (never readable by
 * browser JS — an XSS bug can't exfiltrate it via document.cookie), and
 * every value inside it is independently re-verified server-side on every
 * use: apps/api checks the JWT's own signature on each proxied call, so a
 * tampered accessToken just fails auth (401) — it can never forge access
 * to a different org. Tampering can only break your own session, not
 * escalate privilege. A real production build would still reach for
 * next-iron-session or similar for defense in depth; not required for
 * this phase's scope.
 */
export async function getSession(): Promise<Session | undefined> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return undefined;
  }
}

/** Only callable from a Route Handler or Server Action — Next.js throws if
 *  called during a Server Component's render, since cookies can't be
 *  mutated mid-render. */
export async function setSession(session: Session): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, JSON.stringify(session), {
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
