import { NextResponse } from "next/server";
import { API_BASE_URL } from "../../../../lib/env";
import { setSession, type Session } from "../../../../lib/session";

const REFRESH_COOKIE = "cm_refresh_token";

export async function POST(request: Request) {
  const { email, password } = (await request.json()) as { email?: string; password?: string };

  const res = await fetch(`${API_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return NextResponse.json({ error: body.error ?? "Login failed" }, { status: res.status });
  }

  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
  const refreshToken = setCookie?.split(";")[0]?.split("=")[1];
  if (!refreshToken) {
    return NextResponse.json(
      { error: "Login succeeded but no refresh token was issued" },
      { status: 502 },
    );
  }

  const body = (await res.json()) as { accessToken: string; user: Session["user"] };
  await setSession({ accessToken: body.accessToken, refreshToken, user: body.user });

  return NextResponse.json({ ok: true });
}
