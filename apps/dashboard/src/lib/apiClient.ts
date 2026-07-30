import "server-only";
import { redirect } from "next/navigation";
import { API_BASE_URL } from "./env";
import type { Session } from "./session";

const REFRESH_COOKIE = "cm_refresh_token";

/** Plain, no-retry call to apps/api with the session's access token. */
export function callApi(session: Session, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${session.accessToken}`,
    },
    cache: "no-store",
  });
}

/**
 * Server-to-server refresh: apps/api's POST /auth/refresh reads its own
 * refresh cookie, which only ever exists on ITS origin — the dashboard
 * carries the refresh token value inside its own session cookie instead
 * (see session.ts) and replays it here as a manually-built `Cookie`
 * header, since this is a plain fetch, not a browser request with its own
 * cookie jar. Returns undefined on failure (expired/reused/invalid token)
 * — the caller must treat that as "log in again," not retry further.
 */
export async function refreshSession(session: Session): Promise<Session | undefined> {
  const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
    method: "POST",
    headers: { cookie: `${REFRESH_COOKIE}=${session.refreshToken}` },
    cache: "no-store",
  });
  if (!res.ok) return undefined;

  const newRefreshToken = extractCookieValue(res, REFRESH_COOKIE);
  if (!newRefreshToken) return undefined;

  const body = (await res.json()) as { accessToken: string };
  return { accessToken: body.accessToken, refreshToken: newRefreshToken, user: session.user };
}

/**
 * For Server Components rendering a page's initial data. Deliberately
 * does NOT attempt a silent refresh — a Server Component can't persist a
 * refreshed session cookie mid-render (only Route Handlers/Server Actions
 * can write cookies), so an expired access token here just sends the user
 * back to /login for a full re-authentication instead. Interactive
 * client-side actions get the real refresh-and-retry behavior via the
 * /api/proxy route and `callApiWithRefresh` above.
 */
export async function fetchOrRedirect<T>(session: Session, path: string): Promise<T> {
  const res = await callApi(session, path);
  if (res.status === 401) redirect("/login");
  if (!res.ok) {
    throw new Error(`apps/api returned ${res.status} for ${path}`);
  }
  return res.json() as Promise<T>;
}

function extractCookieValue(res: Response, name: string): string | undefined {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  if (!raw) return undefined;
  return raw.split(";")[0]?.split("=")[1];
}

/**
 * The one function client components' interactive actions go through
 * (via the /api/proxy Route Handler, which is the only place allowed to
 * write cookies) — calls apps/api, and on a 401 (expired access token)
 * transparently refreshes once and retries, persisting the rotated
 * session. Server Components use `callApi` directly instead and redirect
 * to /login on a 401, since a Server Component can't write cookies mid-
 * render to persist a refreshed session — see each page.tsx for that
 * simpler path.
 */
export async function callApiWithRefresh(
  session: Session,
  path: string,
  init: RequestInit,
  onRefreshed: (session: Session) => void | Promise<void>,
): Promise<Response> {
  const res = await callApi(session, path, init);
  if (res.status !== 401) return res;

  const refreshed = await refreshSession(session);
  if (!refreshed) return res;

  await onRefreshed(refreshed);
  return callApi(refreshed, path, init);
}
