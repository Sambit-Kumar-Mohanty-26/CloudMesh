import { MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError } from "../../src/errors.js";
import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { createFakeRedis } from "./fakeRedis.js";

const BASE_URL = "https://api.anthropic.test";

let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  await mockAgent.close();
});

function adapter(apiKey?: string) {
  return new AnthropicAdapter({
    apiKey,
    baseUrl: BASE_URL,
    version: "2023-06-01",
    redis: createFakeRedis(),
  });
}

describe("AnthropicAdapter.chat", () => {
  it("translates a non-streaming response into the unified shape", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(200, {
        id: "msg_abc123",
        content: [{ type: "text", text: "Hello there" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 4 },
      });

    const res = await adapter("test-key").chat({
      model: "claude-3-5-sonnet-latest",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res).toEqual({
      id: "msg_abc123",
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      message: { role: "assistant", content: "Hello there" },
      finishReason: "stop",
      usage: { promptTokens: 12, completionTokens: 4 },
    });
  });

  it("splits system messages out of the messages array into a top-level system field", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({
        path: "/v1/messages",
        method: "POST",
        body: (body) => {
          const parsed = JSON.parse(body as string);
          return (
            parsed.system === "Be terse." &&
            parsed.messages.length === 1 &&
            parsed.messages[0].role === "user"
          );
        },
      })
      .reply(200, {
        id: "msg_1",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    await adapter("test-key").chat({
      model: "claude-3-5-sonnet-latest",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
      ],
    });
    // Interceptor's body matcher already asserted the split; reaching here
    // without an "interceptor not matched" error is the assertion.
  });

  it("defaults max_tokens when the caller doesn't supply one (Anthropic requires it)", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({
        path: "/v1/messages",
        method: "POST",
        body: (body) => JSON.parse(body as string).max_tokens === 1024,
      })
      .reply(200, {
        id: "msg_1",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    await adapter("test-key").chat({
      model: "claude-3-5-sonnet-latest",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("throws ProviderError without a network call when no API key is configured", async () => {
    await expect(
      adapter().chat({
        model: "claude-3-5-sonnet-latest",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(ProviderError);
    mockAgent.assertNoPendingInterceptors();
  });

  it("maps max_tokens stop_reason to 'length'", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(200, {
        id: "msg_2",
        content: [{ type: "text", text: "..." }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 5, output_tokens: 1024 },
      });

    const res = await adapter("test-key").chat({
      model: "claude-3-5-sonnet-latest",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.finishReason).toBe("length");
  });
});

describe("AnthropicAdapter.chatStream", () => {
  it("parses named SSE events into unified stream chunks", async () => {
    const sseBody =
      `event: message_start\n` +
      `data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10}}}\n\n` +
      `event: content_block_delta\n` +
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n` +
      `event: content_block_delta\n` +
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n` +
      `event: message_delta\n` +
      `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n` +
      `event: message_stop\n` +
      `data: {"type":"message_stop"}\n\n`;

    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(200, sseBody, { headers: { "content-type": "text/event-stream" } });

    const chunks = [];
    for await (const chunk of adapter("test-key").chatStream({
      model: "claude-3-5-sonnet-latest",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ id: "msg_1", delta: "Hel", done: false });
    expect(chunks[1]).toMatchObject({ id: "msg_1", delta: "lo", done: false });
    expect(chunks[2]).toMatchObject({
      delta: "",
      done: true,
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 2 },
    });
  });
});

describe("AnthropicAdapter.models", () => {
  it("returns [] without a network call when no API key is configured", async () => {
    const models = await adapter().models();
    expect(models).toEqual([]);
    mockAgent.assertNoPendingInterceptors();
  });

  it("fetches the live catalog", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/models", method: "GET" })
      .reply(200, {
        data: [{ id: "claude-sonnet-5" }, { id: "claude-haiku-4-5-20251001" }],
      });

    const models = await adapter("test-key").models();
    expect(models).toEqual([
      { id: "claude-sonnet-5", provider: "anthropic" },
      { id: "claude-haiku-4-5-20251001", provider: "anthropic" },
    ]);
  });

  it("caches the result — a second call doesn't hit the network again", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/models", method: "GET" })
      .reply(200, { data: [{ id: "claude-sonnet-5" }] });

    const a = adapter("test-key");
    await a.models();
    await a.models();
    mockAgent.assertNoPendingInterceptors();
  });
});
