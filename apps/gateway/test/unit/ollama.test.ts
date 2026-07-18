import { MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError } from "../../src/errors.js";
import { OllamaAdapter } from "../../src/providers/ollama.js";
import { createFakeRedis } from "./fakeRedis.js";

const BASE_URL = "http://ollama.test";

let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  await mockAgent.close();
});

function adapter() {
  return new OllamaAdapter({ baseUrl: BASE_URL, redis: createFakeRedis() });
}

describe("OllamaAdapter.chat", () => {
  it("translates a non-streaming response into the unified shape", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/api/chat", method: "POST" })
      .reply(200, {
        model: "llama3.1",
        message: { role: "assistant", content: "Hello there" },
        done: true,
        prompt_eval_count: 6,
        eval_count: 2,
      });

    const res = await adapter().chat({
      model: "llama3.1",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.message).toEqual({ role: "assistant", content: "Hello there" });
    expect(res.finishReason).toBe("stop");
    expect(res.usage).toEqual({ promptTokens: 6, completionTokens: 2 });
  });

  it("wraps an unreachable server as a clear ProviderError, not a raw network error", async () => {
    // No interceptor registered + disableNetConnect() => fetch rejects,
    // simulating "no local Ollama server running."
    await expect(
      adapter().chat({ model: "llama3.1", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(ProviderError);
  });
});

describe("OllamaAdapter.chatStream", () => {
  it("parses NDJSON lines into unified stream chunks", async () => {
    const ndjson =
      `${JSON.stringify({ message: { role: "assistant", content: "Hel" }, done: false })}\n` +
      `${JSON.stringify({ message: { role: "assistant", content: "lo" }, done: false })}\n` +
      `${JSON.stringify({
        message: { role: "assistant", content: "" },
        done: true,
        prompt_eval_count: 6,
        eval_count: 2,
      })}\n`;

    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/api/chat", method: "POST" })
      .reply(200, ndjson, { headers: { "content-type": "application/x-ndjson" } });

    const chunks = [];
    for await (const chunk of adapter().chatStream({
      model: "llama3.1",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ delta: "Hel", done: false });
    expect(chunks[1]).toMatchObject({ delta: "lo", done: false });
    expect(chunks[2]).toMatchObject({
      delta: "",
      done: true,
      finishReason: "stop",
      usage: { promptTokens: 6, completionTokens: 2 },
    });
  });
});

describe("OllamaAdapter.models", () => {
  it("lists whatever's actually installed locally, via /api/tags", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/api/tags", method: "GET" })
      .reply(200, {
        models: [{ name: "llama3.1:latest" }, { name: "mistral:latest" }],
      });

    const models = await adapter().models();
    expect(models).toEqual([
      { id: "llama3.1:latest", provider: "ollama" },
      { id: "mistral:latest", provider: "ollama" },
    ]);
  });

  it("wraps an unreachable server as a clear ProviderError", async () => {
    await expect(adapter().models()).rejects.toThrow(ProviderError);
  });

  it("caches the result — a second call doesn't hit the network again", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/api/tags", method: "GET" })
      .reply(200, { models: [{ name: "llama3.1:latest" }] });

    const a = adapter();
    await a.models();
    await a.models();
    mockAgent.assertNoPendingInterceptors();
  });
});
