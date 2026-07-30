import { NextResponse } from "next/server";
import { callApiWithRefresh } from "../../../../lib/apiClient";
import { getSession, setSession } from "../../../../lib/session";

/**
 * The one route client components' interactive actions go through (create
 * an API key, revoke one, register a webhook, ...) — same-origin from the
 * browser's point of view, so the httpOnly session cookie is sent
 * automatically, and this is the only place allowed to WRITE that cookie
 * (a Route Handler, not a Server Component render — see session.ts).
 * Server Components fetch apps/api directly instead for read-only page
 * loads; this proxy exists specifically for the transparent refresh-and-
 * retry-on-401 behavior client-side actions need.
 */
async function handle(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { path: pathSegments } = await params;
  const path = `/${pathSegments.join("/")}`;
  const search = new URL(request.url).search;
  const hasBody = request.method !== "GET" && request.method !== "DELETE";
  const body = hasBody ? await request.text() : undefined;

  const res = await callApiWithRefresh(
    session,
    `${path}${search}`,
    {
      method: request.method,
      headers: hasBody ? { "content-type": "application/json" } : {},
      body,
    },
    setSession,
  );

  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export { handle as GET, handle as POST, handle as DELETE, handle as PATCH };
