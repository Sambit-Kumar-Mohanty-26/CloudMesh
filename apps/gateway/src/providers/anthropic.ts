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

const DEFAULT_MAX_TOKENS = 1024;

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

/** Anthropic has no `role: "system"` message — the system prompt is a
 *  separate top-level field. Concatenate any system messages (in order)
 *  and strip them out of the conversation. */
function splitSystemPrompt(messages: UnifiedMessage[]): {
  system: string | undefined;
  rest: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systemParts: string[] = [];
  const rest: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else {
      rest.push({ role: m.role, content: m.content });
    }
  }
  return { system: systemParts.length > 0 ? systemParts.join("\n") : undefined, rest };
}

interface AnthropicMessage {
  id: string;
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicModelList {
  data: Array<{ id: string }>;
}

export interface AnthropicAdapterConfig {
  apiKey?: string;
  baseUrl: string;
  version: string;
  redis: Redis;
}

export class AnthropicAdapter implements LLMProvider {
  readonly name = "anthropic";

  constructor(private readonly config: AnthropicAdapterConfig) {}

  async models(): Promise<ModelInfo[]> {
    if (!this.config.apiKey) return [];
    return cachedModels(this.config.redis, this.name, async () => {
      // Anthropic's models-list endpoint — verify field names against
      // current docs if this ever starts returning unexpected shapes; not
      // independently confirmed against a live account in this environment.
      const res = await fetch(`${this.config.baseUrl}/v1/models`, { headers: this.headers() });
      if (!res.ok) {
        throw new ProviderError(`Anthropic models list failed: ${res.status}`, this.name);
      }
      const body = (await res.json()) as AnthropicModelList;
      return body.data.map((m) => ({ id: m.id, provider: this.name }));
    });
  }

  private headers(): Record<string, string> {
    if (!this.config.apiKey) {
      throw new ProviderError("Anthropic is not configured (missing ANTHROPIC_API_KEY)", this.name);
    }
    return {
      "Content-Type": "application/json",
      "x-api-key": this.config.apiKey,
      "anthropic-version": this.config.version,
    };
  }

  async chat(req: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    const { system, rest } = splitSystemPrompt(req.messages);
    const res = await fetch(`${this.config.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: req.model,
        system,
        messages: rest,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: req.temperature,
      }),
    });

    if (!res.ok) {
      throw new ProviderError(
        `Anthropic request failed: ${res.status} ${await res.text()}`,
        this.name,
      );
    }

    const body = (await res.json()) as AnthropicMessage;
    const text = body.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");

    return {
      id: body.id,
      provider: this.name,
      model: req.model,
      message: { role: "assistant", content: text },
      finishReason: mapFinishReason(body.stop_reason),
      usage: {
        promptTokens: body.usage.input_tokens,
        completionTokens: body.usage.output_tokens,
      },
    };
  }

  async *chatStream(req: UnifiedChatRequest): AsyncIterable<UnifiedChatChunk> {
    const { system, rest } = splitSystemPrompt(req.messages);
    const res = await fetch(`${this.config.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: req.model,
        system,
        messages: rest,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: req.temperature,
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      throw new ProviderError(
        `Anthropic request failed: ${res.status} ${await res.text()}`,
        this.name,
      );
    }

    let id = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let stopReason: string | null = null;

    for await (const payload of parseSSELines(res.body)) {
      // Anthropic's data payloads self-describe their event via `type`, so
      // the `event:` SSE line (which parseSSELines doesn't expose) isn't
      // needed to dispatch on it.
      const event = JSON.parse(payload) as {
        type: string;
        message?: { id: string; usage: { input_tokens: number } };
        delta?: { type?: string; text?: string; stop_reason?: string };
        usage?: { output_tokens: number };
      };

      switch (event.type) {
        case "message_start":
          id = event.message?.id ?? id;
          promptTokens = event.message?.usage.input_tokens ?? 0;
          break;
        case "content_block_delta":
          if (event.delta?.type === "text_delta" && event.delta.text) {
            yield {
              id,
              provider: this.name,
              model: req.model,
              delta: event.delta.text,
              done: false,
            };
          }
          break;
        case "message_delta":
          stopReason = event.delta?.stop_reason ?? stopReason;
          completionTokens = event.usage?.output_tokens ?? completionTokens;
          break;
        case "message_stop":
          yield {
            id,
            provider: this.name,
            model: req.model,
            delta: "",
            done: true,
            finishReason: mapFinishReason(stopReason),
            usage: { promptTokens, completionTokens },
          };
          return;
        default:
          break;
      }
    }
  }
}
