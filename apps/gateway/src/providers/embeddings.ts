import { createHash } from "node:crypto";
import { ProviderError } from "../errors.js";

export const EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingProvider {
  readonly name: string;
  embed(text: string): Promise<number[]>;
}

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

export interface OpenAIEmbeddingAdapterConfig {
  apiKey?: string;
  baseUrl: string;
  model?: string;
}

/**
 * text-embedding-3-small (1536 dims) - same "no live credentials in this
 * environment" caveat as the chat adapters:
 * this is implemented from OpenAI's documented embeddings API shape and unit
 * tested against undici MockAgent, not verified against a live account.
 */
export class OpenAIEmbeddingAdapter implements EmbeddingProvider {
  readonly name = "openai";
  private readonly model: string;

  constructor(private readonly config: OpenAIEmbeddingAdapterConfig) {
    this.model = config.model ?? "text-embedding-3-small";
  }

  async embed(text: string): Promise<number[]> {
    if (!this.config.apiKey) {
      throw new ProviderError("OpenAI is not configured (missing OPENAI_API_KEY)", this.name);
    }

    const res = await fetch(`${this.config.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!res.ok) {
      throw new ProviderError(
        `OpenAI embeddings request failed: ${res.status} ${await res.text()}`,
        this.name,
      );
    }

    const body = (await res.json()) as OpenAIEmbeddingResponse;
    const embedding = body.data[0]?.embedding;
    if (!embedding) {
      throw new ProviderError("OpenAI embeddings response had no data", this.name);
    }
    return embedding;
  }
}

/**
 * Deterministic, no-network embedder for exercising the semantic-cache
 * pipeline (lookup/store/threshold wiring) without a real embeddings key -
 * same purpose as providers/mock.ts's MockProvider, gated behind the same
 * ENABLE_MOCK_PROVIDER flag. It is NOT a semantic embedding: it derives a
 * unit vector deterministically from the exact input text, so identical
 * text always produces cosine similarity 1.0 and different text produces a
 * low/negative similarity - enough to prove the cache's plumbing (org+model
 * scoping, threshold comparison, TTL, invalidation) works, but it proves
 * nothing about real semantic matching quality. Never enable by default in
 * a real deployment config.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";

  async embed(text: string): Promise<number[]> {
    const digest = createHash("sha256").update(text).digest();
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      // Signed byte -> [-1, 1], cycling through the 32-byte digest.
      vector[i] = (digest[i % digest.length]! - 128) / 128;
    }
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => v / norm);
  }
}
