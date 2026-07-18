import { MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError } from "../../src/errors.js";
import { GeminiAdapter } from "../../src/providers/gemini.js";
import { createFakeRedis } from "./fakeRedis.js";

const BASE_URL = "https://generativelanguage.test";

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
  return new GeminiAdapter({ apiKey, baseUrl: BASE_URL, redis: createFakeRedis() });
}

describe("GeminiAdapter.chat", () => {
  it("translates a non-streaming response into the unified shape", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: /\/v1beta\/models\/gemini-1.5-flash:generateContent/, method: "POST" })
      .reply(200, {
        candidates: [{ content: { parts: [{ text: "Hello there" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 },
      });

    const res = await adapter("test-key").chat({
      model: "gemini-1.5-flash",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.message).toEqual({ role: "assistant", content: "Hello there" });
    expect(res.finishReason).toBe("stop");
    expect(res.usage).toEqual({ promptTokens: 8, completionTokens: 2 });
  });

  it("maps assistant role to 'model' and splits system into systemInstruction", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({
        path: /\/v1beta\/models\/gemini-1.5-flash:generateContent/,
        method: "POST",
        body: (body) => {
          const parsed = JSON.parse(body as string);
          return (
            parsed.systemInstruction.parts[0].text === "Be terse." &&
            parsed.contents[0].role === "user" &&
            parsed.contents[1].role === "model"
          );
        },
      })
      .reply(200, {
        candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });

    await adapter("test-key").chat({
      model: "gemini-1.5-flash",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
  });

  it("maps SAFETY finish reason to content_filter", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: /generateContent/, method: "POST" })
      .reply(200, {
        candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "SAFETY" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0 },
      });

    const res = await adapter("test-key").chat({
      model: "gemini-1.5-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.finishReason).toBe("content_filter");
  });

  it("throws ProviderError without a network call when no API key is configured", async () => {
    await expect(
      adapter().chat({ model: "gemini-1.5-flash", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(ProviderError);
    mockAgent.assertNoPendingInterceptors();
  });
});

describe("GeminiAdapter.chatStream", () => {
  it("parses alt=sse chunks into unified stream chunks", async () => {
    const sseBody =
      `data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n` +
      `data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n` +
      `data: {"candidates":[{"content":{"parts":[{"text":""}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n\n`;

    mockAgent
      .get(BASE_URL)
      .intercept({ path: /streamGenerateContent/, method: "POST" })
      .reply(200, sseBody, { headers: { "content-type": "text/event-stream" } });

    const chunks = [];
    for await (const chunk of adapter("test-key").chatStream({
      model: "gemini-1.5-flash",
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
      usage: { promptTokens: 3, completionTokens: 2 },
    });
  });
});

describe("GeminiAdapter.models", () => {
  it("returns [] without a network call when no API key is configured", async () => {
    const models = await adapter().models();
    expect(models).toEqual([]);
    mockAgent.assertNoPendingInterceptors();
  });

  it("fetches the live catalog, strips the models/ prefix, and filters to generateContent-capable models", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: /\/v1beta\/models\?key=/, method: "GET" })
      .reply(200, {
        models: [
          { name: "models/gemini-1.5-pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-1.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
        ],
      });

    const models = await adapter("test-key").models();
    expect(models).toEqual([
      { id: "gemini-1.5-pro", provider: "gemini" },
      { id: "gemini-1.5-flash", provider: "gemini" },
    ]);
  });

  it("caches the result — a second call doesn't hit the network again", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: /\/v1beta\/models\?key=/, method: "GET" })
      .reply(200, {
        models: [
          { name: "models/gemini-1.5-flash", supportedGenerationMethods: ["generateContent"] },
        ],
      });

    const a = adapter("test-key");
    await a.models();
    await a.models();
    mockAgent.assertNoPendingInterceptors();
  });
});
