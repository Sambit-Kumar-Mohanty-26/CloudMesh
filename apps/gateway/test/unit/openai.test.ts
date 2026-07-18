import { MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError } from "../../src/errors.js";
import { OpenAIAdapter } from "../../src/providers/openai.js";
import { createFakeRedis } from "./fakeRedis.js";

const BASE_URL = "https://api.openai.test";

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
  return new OpenAIAdapter({ apiKey, baseUrl: BASE_URL, redis: createFakeRedis() });
}

describe("OpenAIAdapter.chat", () => {
  it("translates a non-streaming response into the unified shape", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(
        200,
        {
          id: "chatcmpl-abc123",
          choices: [
            { message: { role: "assistant", content: "Hello there" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        },
        { headers: { "content-type": "application/json" } },
      );

    const res = await adapter("test-key").chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res).toEqual({
      id: "chatcmpl-abc123",
      provider: "openai",
      model: "gpt-4o-mini",
      message: { role: "assistant", content: "Hello there" },
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 3 },
    });
  });

  it("throws ProviderError without making a network call when no API key is configured", async () => {
    await expect(
      adapter().chat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(ProviderError);
    mockAgent.assertNoPendingInterceptors();
  });

  it("throws ProviderError on a non-2xx upstream response", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(401, "invalid api key");

    await expect(
      adapter("bad-key").chat({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(ProviderError);
  });

  it("maps content_filter finish_reason correctly", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, {
        id: "chatcmpl-x",
        choices: [{ message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
        usage: { prompt_tokens: 5, completion_tokens: 0 },
      });

    const res = await adapter("test-key").chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.finishReason).toBe("content_filter");
  });
});

describe("OpenAIAdapter.chatStream", () => {
  it("parses SSE chunks into unified stream chunks, stopping at [DONE]", async () => {
    const sseBody =
      `data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n` +
      `data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n` +
      `data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, sseBody, { headers: { "content-type": "text/event-stream" } });

    const chunks = [];
    for await (const chunk of adapter("test-key").chatStream({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ delta: "Hel", done: false });
    expect(chunks[1]).toMatchObject({ delta: "lo", done: false });
    expect(chunks[2]).toMatchObject({ delta: "", done: true, finishReason: "stop" });
  });
});

describe("OpenAIAdapter.models", () => {
  it("returns [] without a network call when no API key is configured", async () => {
    const models = await adapter().models();
    expect(models).toEqual([]);
    mockAgent.assertNoPendingInterceptors();
  });

  it("fetches the live catalog and filters out obviously non-chat models", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/models", method: "GET" })
      .reply(200, {
        data: [
          { id: "gpt-4o" },
          { id: "gpt-4o-mini" },
          { id: "text-embedding-3-small" },
          { id: "whisper-1" },
          { id: "dall-e-3" },
        ],
      });

    const models = await adapter("test-key").models();
    expect(models).toEqual([
      { id: "gpt-4o", provider: "openai" },
      { id: "gpt-4o-mini", provider: "openai" },
    ]);
  });

  it("caches the result — a second call doesn't hit the network again", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/models", method: "GET" })
      .reply(200, { data: [{ id: "gpt-4o" }] });

    const a = adapter("test-key");
    const first = await a.models();
    const second = await a.models();

    expect(first).toEqual(second);
    mockAgent.assertNoPendingInterceptors();
  });

  it("throws ProviderError on a non-2xx models-list response", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/models", method: "GET" })
      .reply(500, "internal error");

    await expect(adapter("test-key").models()).rejects.toThrow(ProviderError);
  });
});
