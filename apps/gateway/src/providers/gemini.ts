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
  UnifiedMessage,
} from "./types.js";

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    default:
      return "stop";
  }
}

/** Gemini has no `role: "system"` in `contents` — the system prompt is a
 *  separate `systemInstruction` field, and assistant turns are role
 *  "model", not "assistant". */
function toGeminiPayload(messages: UnifiedMessage[]) {
  const systemParts: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: [{ text: string }] }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else {
      contents.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      });
    }
  }
  return {
    contents,
    systemInstruction:
      systemParts.length > 0 ? { parts: [{ text: systemParts.join("\n") }] } : undefined,
  };
}

interface GeminiCandidate {
  content: { parts: Array<{ text?: string }> };
  finishReason?: string;
}

interface GeminiResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
}

interface GeminiModelList {
  models: Array<{ name: string; supportedGenerationMethods?: string[] }>;
}

export interface GeminiAdapterConfig {
  apiKey?: string;
  baseUrl: string;
  redis: Redis;
}

export class GeminiAdapter implements LLMProvider {
  readonly name = "gemini";

  constructor(private readonly config: GeminiAdapterConfig) {}

  async models(): Promise<ModelInfo[]> {
    if (!this.config.apiKey) return [];
    return cachedModels(this.config.redis, this.name, async () => {
      const res = await fetch(`${this.config.baseUrl}/v1beta/models?key=${this.config.apiKey}`);
      if (!res.ok) {
        throw new ProviderError(`Gemini models list failed: ${res.status}`, this.name);
      }
      const body = (await res.json()) as GeminiModelList;
      return body.models
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => ({ id: m.name.replace(/^models\//, ""), provider: this.name }));
    });
  }

  private requireApiKey(): string {
    if (!this.config.apiKey) {
      throw new ProviderError("Gemini is not configured (missing GEMINI_API_KEY)", this.name);
    }
    return this.config.apiKey;
  }

  async chat(req: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    const apiKey = this.requireApiKey();
    const { contents, systemInstruction } = toGeminiPayload(req.messages);

    const res = await fetch(
      `${this.config.baseUrl}/v1beta/models/${req.model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          systemInstruction,
          generationConfig: {
            maxOutputTokens: req.maxTokens,
            temperature: req.temperature,
          },
        }),
      },
    );

    if (!res.ok) {
      throw new ProviderError(
        `Gemini request failed: ${res.status} ${await res.text()}`,
        this.name,
      );
    }

    const body = (await res.json()) as GeminiResponse;
    const candidate = body.candidates[0];
    if (!candidate) {
      throw new ProviderError("Gemini response had no candidates", this.name);
    }
    const text = candidate.content.parts.map((p) => p.text ?? "").join("");

    return {
      id: crypto.randomUUID(),
      provider: this.name,
      model: req.model,
      message: { role: "assistant", content: text },
      finishReason: mapFinishReason(candidate.finishReason),
      usage: {
        promptTokens: body.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

  async *chatStream(req: UnifiedChatRequest): AsyncIterable<UnifiedChatChunk> {
    const apiKey = this.requireApiKey();
    const { contents, systemInstruction } = toGeminiPayload(req.messages);

    // `alt=sse` switches Gemini's stream endpoint from a bare JSON array to
    // standard `data: {...}\n\n` framing, so the same parseSSELines used
    // for OpenAI/Anthropic works here too.
    const res = await fetch(
      `${this.config.baseUrl}/v1beta/models/${req.model}:streamGenerateContent?alt=sse&key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          systemInstruction,
          generationConfig: {
            maxOutputTokens: req.maxTokens,
            temperature: req.temperature,
          },
        }),
      },
    );

    if (!res.ok || !res.body) {
      throw new ProviderError(
        `Gemini request failed: ${res.status} ${await res.text()}`,
        this.name,
      );
    }

    const id = crypto.randomUUID();
    for await (const payload of parseSSELines(res.body)) {
      const chunk = JSON.parse(payload) as GeminiResponse;
      const candidate = chunk.candidates[0];
      if (!candidate) continue;

      const text = candidate.content.parts.map((p) => p.text ?? "").join("");
      const isFinal = Boolean(candidate.finishReason);

      yield {
        id,
        provider: this.name,
        model: req.model,
        delta: text,
        done: isFinal,
        finishReason: isFinal ? mapFinishReason(candidate.finishReason) : undefined,
        usage: isFinal
          ? {
              promptTokens: chunk.usageMetadata?.promptTokenCount ?? 0,
              completionTokens: chunk.usageMetadata?.candidatesTokenCount ?? 0,
            }
          : undefined,
      };
    }
  }
}
