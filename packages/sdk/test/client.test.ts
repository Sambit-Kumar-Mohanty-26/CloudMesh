import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  BudgetExceededError,
  CloudMesh,
  InvalidRequestError,
  NotFoundError,
  RateLimitError,
  ServiceError,
} from "../src/index.js";

/** Builds a fetch stub that returns queued responses in order. */
function stubFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("stubFetch: no response queued");
    return next;
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sse(frames: string[]): Response {
  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// Captured verbatim from a real gateway response — the API sends
// `provider`/`finishReason` and does NOT send `usage.totalTokens`.
const OK_CHAT = {
  id: "c1",
  provider: "mock",
  model: "gpt-4o-mini",
  message: { role: "assistant", content: "hi" },
  finishReason: "stop",
  usage: { promptTokens: 1, completionTokens: 3 },
};

function client(fetchImpl: typeof globalThis.fetch, overrides = {}) {
  return new CloudMesh({
    apiKey: "cm_live_test_key",
    baseUrl: "https://api.test",
    maxRetries: 2,
    ...overrides,
    fetch: fetchImpl,
  });
}

describe("CloudMesh client", () => {
  it("requires an API key", () => {
    expect(() => new CloudMesh({ apiKey: "" })).toThrow(/apiKey is required/);
  });

  it("sends the key as a bearer token and never in the URL", async () => {
    const { fetch, calls } = stubFetch([json(OK_CHAT)]);
    await client(fetch).chat.create({ model: "auto", messages: [{ role: "user", content: "hi" }] });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer cm_live_test_key");
    // A key in a query string lands in access logs and proxy history.
    expect(calls[0]!.url).not.toContain("cm_live_test_key");
  });

  it("strips a trailing slash from baseUrl so paths don't double up", async () => {
    const { fetch, calls } = stubFetch([json(OK_CHAT)]);
    await client(fetch, { baseUrl: "https://api.test/" }).chat.create({
      model: "auto",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(calls[0]!.url).toBe("https://api.test/v1/chat");
  });

  it("computes totalTokens, which the API does not send", async () => {
    const { fetch } = stubFetch([json(OK_CHAT)]);
    const res = await client(fetch).chat.create({
      model: "auto",
      messages: [{ role: "user", content: "x" }],
    });

    // Server sends promptTokens: 1, completionTokens: 3 and no total.
    expect(res.usage.totalTokens).toBe(4);
    expect(res.provider).toBe("mock");
    expect(res.finishReason).toBe("stop");
  });

  it("forces stream:false on chat.create", async () => {
    const { fetch, calls } = stubFetch([json(OK_CHAT)]);
    await client(fetch).chat.create({ model: "auto", messages: [{ role: "user", content: "x" }] });

    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ stream: false });
  });

  it("passes an idempotency key as a header, not a body field", async () => {
    const { fetch, calls } = stubFetch([json(OK_CHAT)]);
    await client(fetch).chat.create({
      model: "auto",
      messages: [{ role: "user", content: "x" }],
      idempotencyKey: "key-123",
    });

    expect((calls[0]!.init.headers as Record<string, string>)["idempotency-key"]).toBe("key-123");
    expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty("idempotencyKey");
  });

  describe("error mapping", () => {
    it.each([
      [400, InvalidRequestError],
      [401, AuthenticationError],
      [402, BudgetExceededError],
      [404, NotFoundError],
      [502, ServiceError],
    ])("maps HTTP %i to a typed error", async (status, ErrorClass) => {
      const { fetch } = stubFetch([json({ error: "nope", code: "SOME_CODE" }, status)]);

      await expect(
        client(fetch, { maxRetries: 0 }).chat.create({
          model: "auto",
          messages: [{ role: "user", content: "x" }],
        }),
      ).rejects.toBeInstanceOf(ErrorClass);
    });

    it("preserves the server's stable code, which is what callers switch on", async () => {
      const { fetch } = stubFetch([json({ error: "no budget", code: "BUDGET_EXCEEDED" }, 402)]);

      await expect(client(fetch, { maxRetries: 0 }).models.list()).rejects.toMatchObject({
        code: "BUDGET_EXCEEDED",
        status: 402,
      });
    });

    it("still produces a typed error when the body isn't JSON", async () => {
      const { fetch } = stubFetch([new Response("<html>502</html>", { status: 502 })]);

      await expect(client(fetch, { maxRetries: 0 }).models.list()).rejects.toBeInstanceOf(
        ServiceError,
      );
    });
  });

  describe("retries", () => {
    it("retries a 429 and honours Retry-After", async () => {
      const { fetch, calls } = stubFetch([
        json({ error: "slow down", code: "RATE_LIMITED" }, 429, { "retry-after": "0" }),
        json(OK_CHAT),
      ]);

      const res = await client(fetch).chat.create({
        model: "auto",
        messages: [{ role: "user", content: "x" }],
      });

      expect(res.id).toBe("c1");
      expect(calls).toHaveLength(2);
    });

    it("does NOT retry a 400 — it would fail identically forever", async () => {
      const { fetch, calls } = stubFetch([json({ error: "bad", code: "VALIDATION_ERROR" }, 400)]);

      await expect(
        client(fetch).chat.create({ model: "auto", messages: [{ role: "user", content: "x" }] }),
      ).rejects.toBeInstanceOf(InvalidRequestError);
      expect(calls).toHaveLength(1);
    });

    it("does NOT retry a 402 — retrying just hammers an exhausted budget", async () => {
      const { fetch, calls } = stubFetch([json({ error: "no budget", code: "BUDGET" }, 402)]);

      await expect(client(fetch).models.list()).rejects.toBeInstanceOf(BudgetExceededError);
      expect(calls).toHaveLength(1);
    });

    it("gives up after maxRetries and surfaces the last error", async () => {
      const { fetch, calls } = stubFetch([
        json({ error: "boom", code: "X" }, 503, { "retry-after": "0" }),
        json({ error: "boom", code: "X" }, 503, { "retry-after": "0" }),
        json({ error: "boom", code: "X" }, 503, { "retry-after": "0" }),
      ]);

      await expect(client(fetch).models.list()).rejects.toBeInstanceOf(ServiceError);
      expect(calls).toHaveLength(3); // initial + 2 retries
    });

    it("exposes retryAfterSeconds on a rate limit error", async () => {
      const { fetch } = stubFetch([
        json({ error: "slow", code: "RATE_LIMITED" }, 429, { "retry-after": "7" }),
      ]);

      await expect(client(fetch, { maxRetries: 0 }).models.list()).rejects.toMatchObject({
        retryAfterSeconds: 7,
      });
      await expect(
        client(stubFetch([json({ error: "s", code: "R" }, 429, { "retry-after": "7" })]).fetch, {
          maxRetries: 0,
        }).models.list(),
      ).rejects.toBeInstanceOf(RateLimitError);
    });
  });

  describe("streaming", () => {
    it("yields deltas and stops at [DONE]", async () => {
      const { fetch } = stubFetch([
        sse([
          'data: {"delta":"Hel"}\n\n',
          'data: {"delta":"lo"}\n\n',
          "data: [DONE]\n\n",
          'data: {"delta":"never"}\n\n',
        ]),
      ]);

      const out: string[] = [];
      for await (const chunk of client(fetch).chat.stream({
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
      })) {
        out.push(chunk.text);
      }

      expect(out.join("")).toBe("Hello");
    });

    it("reassembles a frame split across network chunks", async () => {
      // The real failure mode this guards: a `data:` line arriving in two
      // TCP reads must not be parsed as two broken frames.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode('data: {"de'));
          controller.enqueue(enc.encode('lta":"split"}\n\n'));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      const { fetch } = stubFetch([
        new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      ]);

      const out: string[] = [];
      for await (const chunk of client(fetch).chat.stream({
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
      })) {
        out.push(chunk.text);
      }

      expect(out).toEqual(["split"]);
    });

    it("skips a malformed frame instead of killing the stream", async () => {
      const { fetch } = stubFetch([
        sse(['data: {"delta":"a"}\n\n', "data: {not json}\n\n", 'data: {"delta":"b"}\n\n']),
      ]);

      const out: string[] = [];
      for await (const chunk of client(fetch).chat.stream({
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
      })) {
        out.push(chunk.text);
      }

      expect(out).toEqual(["a", "b"]);
    });

    it("surfaces an error status before streaming begins", async () => {
      const { fetch } = stubFetch([json({ error: "nope", code: "RATE_LIMITED" }, 429)]);

      const iterator = client(fetch, { maxRetries: 0 }).chat.stream({
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
      });

      await expect(iterator.next()).rejects.toBeInstanceOf(RateLimitError);
    });
  });

  describe("jobs", () => {
    it("url-encodes the id so a crafted id cannot alter the path", async () => {
      const { fetch, calls } = stubFetch([json({ id: "x" })]);
      await client(fetch).jobs.get("../../admin");

      expect(calls[0]!.url).toBe("https://api.test/v1/jobs/..%2F..%2Fadmin");
    });

    it("builds a query string only from provided filters", async () => {
      const { fetch, calls } = stubFetch([json({ jobs: [] })]);
      await client(fetch).jobs.list({ status: "DEAD_LETTER", limit: 5 });

      expect(calls[0]!.url).toBe("https://api.test/v1/jobs?status=DEAD_LETTER&limit=5");
    });

    it("omits the query string entirely when no filters are given", async () => {
      const { fetch, calls } = stubFetch([json({ jobs: [] })]);
      await client(fetch).jobs.list();

      expect(calls[0]!.url).toBe("https://api.test/v1/jobs");
    });
  });
});
