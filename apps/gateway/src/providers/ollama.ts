import type { Redis } from "ioredis";
import { ProviderError } from "../errors.js";
import { cachedModels } from "../lib/modelsCache.js";
import { parseNDJSONLines } from "../lib/sse.js";
import type {
  LLMProvider,
  ModelInfo,
  UnifiedChatChunk,
  UnifiedChatRequest,
  UnifiedChatResponse,
} from "./types.js";

interface OllamaChatResponse {
  message: { role: string; content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagsResponse {
  models: Array<{ name: string }>;
}

export interface OllamaAdapterConfig {
  baseUrl: string;
  redis: Redis;
}

async function callOllama(baseUrl: string, name: string, payload: unknown): Promise<Response> {
  try {
    return await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Unlike the hosted providers, "not configured" for Ollama usually
    // means "no local server running" — a connection error, not a 4xx.
    throw new ProviderError(
      `Could not reach Ollama at ${baseUrl} — is it running? (${(err as Error).message})`,
      name,
    );
  }
}

export class OllamaAdapter implements LLMProvider {
  readonly name = "ollama";

  constructor(private readonly config: OllamaAdapterConfig) {}

  async models(): Promise<ModelInfo[]> {
    return cachedModels(this.config.redis, this.name, async () => {
      // /api/tags lists whatever models are ACTUALLY currently pulled on
      // this Ollama instance — unlike the hosted providers, there's no
      // fixed catalog to enumerate, so this is the only source of truth.
      let res: Response;
      try {
        res = await fetch(`${this.config.baseUrl}/api/tags`);
      } catch (err) {
        throw new ProviderError(
          `Could not reach Ollama at ${this.config.baseUrl} — is it running? (${(err as Error).message})`,
          this.name,
        );
      }
      if (!res.ok) {
        throw new ProviderError(`Ollama tags request failed: ${res.status}`, this.name);
      }
      const body = (await res.json()) as OllamaTagsResponse;
      return body.models.map((m) => ({ id: m.name, provider: this.name }));
    });
  }

  async chat(req: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    const res = await callOllama(this.config.baseUrl, this.name, {
      model: req.model,
      messages: req.messages,
      stream: false,
      options: { temperature: req.temperature, num_predict: req.maxTokens },
    });

    if (!res.ok) {
      throw new ProviderError(
        `Ollama request failed: ${res.status} ${await res.text()}`,
        this.name,
      );
    }

    const body = (await res.json()) as OllamaChatResponse;

    return {
      id: crypto.randomUUID(),
      provider: this.name,
      model: req.model,
      message: { role: "assistant", content: body.message.content },
      // Ollama doesn't distinguish length/content_filter the way hosted
      // providers do — every normal completion just reports done:true.
      finishReason: "stop",
      usage: {
        promptTokens: body.prompt_eval_count ?? 0,
        completionTokens: body.eval_count ?? 0,
      },
    };
  }

  async *chatStream(req: UnifiedChatRequest): AsyncIterable<UnifiedChatChunk> {
    const res = await callOllama(this.config.baseUrl, this.name, {
      model: req.model,
      messages: req.messages,
      stream: true,
      options: { temperature: req.temperature, num_predict: req.maxTokens },
    });

    if (!res.ok || !res.body) {
      throw new ProviderError(
        `Ollama request failed: ${res.status} ${await res.text()}`,
        this.name,
      );
    }

    const id = crypto.randomUUID();
    for await (const line of parseNDJSONLines(res.body)) {
      const chunk = JSON.parse(line) as OllamaChatResponse;
      yield {
        id,
        provider: this.name,
        model: req.model,
        delta: chunk.message.content,
        done: chunk.done,
        finishReason: chunk.done ? "stop" : undefined,
        usage: chunk.done
          ? { promptTokens: chunk.prompt_eval_count ?? 0, completionTokens: chunk.eval_count ?? 0 }
          : undefined,
      };
    }
  }
}
