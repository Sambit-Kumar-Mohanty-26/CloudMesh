import { NextResponse } from "next/server";
import { API_BASE_URL } from "../../../../lib/env";
import { clearSession, getSession } from "../../../../lib/session";

const REFRESH_COOKIE = "cm_refresh_token";

export async function POST() {
  const session = await getSession();
  if (session) {
    // Best-effort — the refresh token is invalidated server-side too, but
    // the dashboard's own session cookie is cleared unconditionally below
    // regardless of whether this call succeeds.
    await fetch(`${API_BASE_URL}/auth/logout`, {
      method: "POST",
      headers: { cookie: `${REFRESH_COOKIE}=${session.refreshToken}` },
      cache: "no-store",
    }).catch(() => undefined);
  }
  await clearSession();
  return NextResponse.json({ ok: true });
}
