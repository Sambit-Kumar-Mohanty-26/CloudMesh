import { GATEWAY_BASE_URL } from "../../../../lib/env";

/**
 * A raw pass-through proxy to apps/gateway's POST /v1/chat, streaming the
 * upstream response body straight through unmodified — NOT the same
 * refresh-aware pattern as /api/proxy/[...path]: the playground
 * authenticates with an org API key the user pastes in (Phase 2's
 * resolveApiKey chain), not the dashboard's own JWT session, so there's no
 * refresh token to rotate here.
 *
 * Proxying (rather than the browser calling the gateway directly) isn't
 * just BFF-pattern consistency — apps/gateway has no CORS configured, so a
 * direct cross-origin browser fetch from the dashboard's own port would be
 * blocked outright. This route is same-origin from the browser's
 * perspective, so no CORS story is needed at all.
 */
export async function POST(request: Request): Promise<Response> {
  const apiKey = request.headers.get("x-cloudmesh-playground-key");
  if (!apiKey) {
    return Response.json({ error: "Missing API key" }, { status: 401 });
  }

  const body = await request.text();
  const upstream = await fetch(`${GATEWAY_BASE_URL}/v1/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    },
  });
}
