import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { ProviderError } from "../errors.js";
import { cachedModels } from "../lib/modelsCache.js";
import { parseSSELines } from "../lib/sse.js";
import type {
  FinishReason,
  LLMProvider,
  ModelInfo,
  UnifiedChatChunk,
  UnifiedChatRequest,
  UnifiedChatResponse,
} from "./types.js";

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

// OpenAI's /v1/models lists every model available to the account —
// embeddings, TTS, Whisper, moderation, image generation — not just chat
// models. There's no reliable field to filter on, so this is a best-effort
// substring heuristic, not a guarantee; verify against current docs if it
// starts admitting or excluding the wrong things.
const NON_CHAT_SUBSTRINGS = [
  "embedding",
  "whisper",
  "tts",
  "dall-e",
  "moderation",
  "davinci",
  "babbage",
  "curie",
  "ada",
];

function looksLikeChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CHAT_SUBSTRINGS.some((s) => lower.includes(s));
}

interface OpenAIChatCompletion {
  id: string;
  choices: Array<{ message: { role: string; content: string }; finish_reason: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface OpenAIStreamChunk {
  id: string;
  choices: Array<{ delta: { content?: string }; finish_reason: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
}

interface OpenAIModelList {
  data: Array<{ id: string }>;
}

export interface OpenAIAdapterConfig {
  apiKey?: string;
  baseUrl: string;
  redis: Redis;
}

export class OpenAIAdapter implements LLMProvider {
  readonly name = "openai";

  constructor(private readonly config: OpenAIAdapterConfig) {}

  async models(): Promise<ModelInfo[]> {
    if (!this.config.apiKey) return [];
    return cachedModels(this.config.redis, this.name, async () => {
      const res = await fetch(`${this.config.baseUrl}/v1/models`, { headers: this.headers() });
      if (!res.ok) {
        throw new ProviderError(`OpenAI models list failed: ${res.status}`, this.name);
      }
      const body = (await res.json()) as OpenAIModelList;
      return body.data
        .filter((m) => looksLikeChatModel(m.id))
        .map((m) => ({ id: m.id, provider: this.name }));
    });
  }

  private headers(): Record<string, string> {
    if (!this.config.apiKey) {
      throw new ProviderError("OpenAI is not configured (missing OPENAI_API_KEY)", this.name);
    }
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  async chat(req: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    const res = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
      }),
    });

    if (!res.ok) {
      throw new ProviderError(
        `OpenAI request failed: ${res.status} ${await res.text()}`,
        this.name,
      );
    }

    const body = (await res.json()) as OpenAIChatCompletion;
    const choice = body.choices[0];
    if (!choice) {
      throw new ProviderError("OpenAI response had no choices", this.name);
    }

    return {
      id: body.id,
      provider: this.name,
      model: req.model,
      message: { role: "assistant", content: choice.message.content },
      finishReason: mapFinishReason(choice.finish_reason),
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
      },
    };
  }

  async *chatStream(req: UnifiedChatRequest): AsyncIterable<UnifiedChatChunk> {
    const res = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      throw new ProviderError(
        `OpenAI request failed: ${res.status} ${await res.text()}`,
        this.name,
      );
    }

    const id = randomUUID();
    for await (const payload of parseSSELines(res.body)) {
      if (payload === "[DONE]") return;

      const chunk = JSON.parse(payload) as OpenAIStreamChunk;
      const choice = chunk.choices[0];
      if (!choice) continue;

      const isFinal = choice.finish_reason !== null && choice.finish_reason !== undefined;
      yield {
        id: chunk.id ?? id,
        provider: this.name,
        model: req.model,
        delta: choice.delta.content ?? "",
        done: isFinal,
        finishReason: isFinal ? mapFinishReason(choice.finish_reason) : undefined,
        usage: chunk.usage
          ? {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
            }
          : undefined,
      };
    }
  }
}
