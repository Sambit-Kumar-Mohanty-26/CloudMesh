import { MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError } from "../../src/errors.js";
import {
  EMBEDDING_DIMENSIONS,
  MockEmbeddingProvider,
  OpenAIEmbeddingAdapter,
} from "../../src/providers/embeddings.js";

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
  return new OpenAIEmbeddingAdapter({ apiKey, baseUrl: BASE_URL });
}

describe("OpenAIEmbeddingAdapter", () => {
  it("parses a successful embeddings response into a plain vector", async () => {
    const vector = new Array(EMBEDDING_DIMENSIONS).fill(0.01);
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/embeddings", method: "POST" })
      .reply(200, { data: [{ embedding: vector }] });

    const result = await adapter("test-key").embed("hello world");
    expect(result).toEqual(vector);
  });

  it("sends the configured model and input text in the request body", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({
        path: "/v1/embeddings",
        method: "POST",
        body: JSON.stringify({ model: "text-embedding-3-small", input: "hello world" }),
      })
      .reply(200, { data: [{ embedding: [0.1] }] });

    await expect(adapter("test-key").embed("hello world")).resolves.toEqual([0.1]);
  });

  it("throws ProviderError without a network call when no API key is configured", async () => {
    await expect(adapter().embed("hi")).rejects.toThrow(ProviderError);
    mockAgent.assertNoPendingInterceptors();
  });

  it("throws ProviderError on a non-2xx upstream response", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/embeddings", method: "POST" })
      .reply(401, "invalid api key");

    await expect(adapter("bad-key").embed("hi")).rejects.toThrow(ProviderError);
  });

  it("throws ProviderError when the response has no embedding data", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/embeddings", method: "POST" })
      .reply(200, { data: [] });

    await expect(adapter("test-key").embed("hi")).rejects.toThrow(ProviderError);
  });
});

describe("MockEmbeddingProvider", () => {
  it("returns a unit vector of the expected dimensionality", async () => {
    const result = await new MockEmbeddingProvider().embed("hello");
    expect(result).toHaveLength(EMBEDDING_DIMENSIONS);
    const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("is deterministic — the same text always produces the same vector", async () => {
    const provider = new MockEmbeddingProvider();
    const a = await provider.embed("explain JWT tokens");
    const b = await provider.embed("explain JWT tokens");
    expect(a).toEqual(b);
  });

  it("produces different vectors for different text", async () => {
    const provider = new MockEmbeddingProvider();
    const a = await provider.embed("explain JWT tokens");
    const b = await provider.embed("what's the weather in Tokyo");
    expect(a).not.toEqual(b);
  });
});
