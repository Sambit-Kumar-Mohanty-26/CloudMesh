import { randomUUID } from "node:crypto";
import type {
  LLMProvider,
  ModelInfo,
  UnifiedChatChunk,
  UnifiedChatRequest,
  UnifiedChatResponse,
} from "./types.js";

const MODEL_ID = "mock-echo";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A canned, no-network provider — echoes the last user message back
 * word-by-word. Exists purely so the gateway's own pipeline (auth,
 * idempotency, request validation, SSE framing, error handling) can be
 * exercised for real, end to end, without any live OpenAI/Anthropic/
 * Gemini/Ollama credentials. Gated behind ENABLE_MOCK_PROVIDER — never on
 * by default, and the model registry only registers it when that's true.
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock";

  async models(): Promise<ModelInfo[]> {
    return [{ id: MODEL_ID, provider: this.name }];
  }

  private reply(req: UnifiedChatRequest): string {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    return `echo: ${lastUser?.content ?? ""}`;
  }

  async chat(req: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    const content = this.reply(req);
    return {
      id: randomUUID(),
      provider: this.name,
      model: req.model,
      message: { role: "assistant", content },
      finishReason: "stop",
      usage: { promptTokens: req.messages.length, completionTokens: content.split(" ").length },
    };
  }

  async *chatStream(req: UnifiedChatRequest): AsyncIterable<UnifiedChatChunk> {
    const id = randomUUID();
    const words = this.reply(req).split(" ");
    for (const word of words) {
      await sleep(10);
      yield { id, provider: this.name, model: req.model, delta: `${word} `, done: false };
    }
    yield {
      id,
      provider: this.name,
      model: req.model,
      delta: "",
      done: true,
      finishReason: "stop",
      usage: { promptTokens: req.messages.length, completionTokens: words.length },
    };
  }
}
