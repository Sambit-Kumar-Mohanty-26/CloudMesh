import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApiKey, createTestApp, resetAll } from "./helpers.js";

function parseSSEPayloads(raw: string): unknown[] {
  return raw
    .split("\n\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((payload) => payload !== "[DONE]")
    .map((payload) => JSON.parse(payload));
}

describe("POST /v1/chat — streaming", () => {
  let app: FastifyInstance;
  let rawKey: string;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetAll(app);
    ({ rawKey } = await createTestApiKey());
  });

  it("streams SSE chunks that reassemble into the full echoed message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "mock-echo",
        messages: [{ role: "user", content: "stream this back" }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body.trim().endsWith("data: [DONE]")).toBe(true);

    const chunks = parseSSEPayloads(res.body) as Array<{ delta: string; done: boolean }>;
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[chunks.length - 1]?.done).toBe(true);

    const fullText = chunks.map((c) => c.delta).join("");
    expect(fullText.trim()).toBe("echo: stream this back");
  });

  it("streaming an unconfigured real provider fails as a clean 502 JSON error, not a broken stream", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
    });

    // The route pulls the first chunk before committing to SSE headers, so
    // an immediate provider failure (missing key) must still be a normal
    // JSON 502 — not a 200 with a broken/empty event-stream body.
    expect(res.statusCode).toBe(502);
    expect(res.headers["content-type"]).not.toContain("text/event-stream");
    expect(res.json().code).toBe("PROVIDER_ERROR");
  });
});
