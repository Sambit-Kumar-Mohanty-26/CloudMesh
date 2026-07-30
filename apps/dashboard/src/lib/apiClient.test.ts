import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// "server-only" is one of Next.js's own internal webpack aliases (it
// vendors a copy under next/dist/compiled and rewires bare imports of it
// during its own build) — outside Next's bundler, plain Node/vitest module
// resolution has nothing to find. Stubbing it here is what lets this file
// import apiClient.ts directly instead of needing a full Next.js test
// harness; `next build`'s own successful compile (verified separately) is
// what actually proves the real, bundled import resolves correctly.
vi.mock("server-only", () => ({}));

// fetchOrRedirect (untested here) calls next/navigation's redirect(),
// which throws a special NEXT_REDIRECT control-flow error that only makes
// sense inside a real Next.js request lifecycle — not mocked here since
// none of these tests exercise that function.

const { callApi, callApiWithRefresh, refreshSession } = await import("./apiClient.js");
const { API_BASE_URL } = await import("./env.js");

const session = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  user: { id: "u1", email: "a@b.test", role: "OWNER", orgId: "org-1" },
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callApi", () => {
  it("sends the session's access token as a Bearer header", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await callApi(session, "/billing/status");

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/billing/status`,
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer access-1" }),
      }),
    );
  });
});

describe("refreshSession", () => {
  it("returns an updated session with the rotated refresh token on success", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ accessToken: "access-2" }), {
        status: 200,
        headers: { "set-cookie": "cm_refresh_token=refresh-2; Path=/auth; HttpOnly" },
      }),
    );

    const result = await refreshSession(session);
    expect(result).toEqual({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      user: session.user,
    });
  });

  it("sends the current refresh token as a manually-built Cookie header", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ accessToken: "access-2" }), {
        status: 200,
        headers: { "set-cookie": "cm_refresh_token=refresh-2; Path=/auth" },
      }),
    );
    await refreshSession(session);

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/auth/refresh`,
      expect.objectContaining({
        headers: expect.objectContaining({ cookie: "cm_refresh_token=refresh-1" }),
      }),
    );
  });

  it("returns undefined when apps/api rejects the refresh (expired/reused token)", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    expect(await refreshSession(session)).toBeUndefined();
  });

  it("returns undefined if the response has no refresh cookie at all", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ accessToken: "access-2" }), { status: 200 }),
    );
    expect(await refreshSession(session)).toBeUndefined();
  });
});

describe("callApiWithRefresh", () => {
  it("returns the response directly when the first call succeeds", async () => {
    const ok = new Response("{}", { status: 200 });
    fetchMock.mockResolvedValueOnce(ok);
    const onRefreshed = vi.fn();

    const res = await callApiWithRefresh(session, "/billing/status", {}, onRefreshed);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onRefreshed).not.toHaveBeenCalled();
  });

  it("refreshes once and retries on a 401, persisting the rotated session", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 })) // initial call
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: "access-2" }), {
          status: 200,
          headers: { "set-cookie": "cm_refresh_token=refresh-2; Path=/auth" },
        }),
      ) // refresh call
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })); // retried call
    const onRefreshed = vi.fn();

    const res = await callApiWithRefresh(session, "/billing/status", {}, onRefreshed);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(onRefreshed).toHaveBeenCalledWith({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      user: session.user,
    });
    // The retried call used the NEW access token, not the stale one.
    expect(fetchMock).toHaveBeenLastCalledWith(
      `${API_BASE_URL}/billing/status`,
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer access-2" }),
      }),
    );
  });

  it("gives up and returns the original 401 when refresh itself fails", async () => {
    const unauthorized = new Response(null, { status: 401 });
    fetchMock
      .mockResolvedValueOnce(unauthorized) // initial call
      .mockResolvedValueOnce(new Response(null, { status: 401 })); // refresh call fails too
    const onRefreshed = vi.fn();

    const res = await callApiWithRefresh(session, "/billing/status", {}, onRefreshed);
    expect(res.status).toBe(401);
    expect(onRefreshed).not.toHaveBeenCalled();
    // No third (retry) call was ever made.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
