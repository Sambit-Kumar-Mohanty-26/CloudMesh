export type Role = "system" | "user" | "assistant";

export interface UnifiedMessage {
  role: Role;
  content: string;
}

export interface UnifiedChatRequest {
  /** The provider-specific model id — already resolved by the registry, an
   *  adapter never sees "auto" or a CloudMesh alias. */
  model: string;
  messages: UnifiedMessage[];
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface UnifiedUsage {
  promptTokens: number;
  completionTokens: number;
}

export type FinishReason = "stop" | "length" | "content_filter" | "error";

export interface UnifiedChatResponse {
  id: string;
  provider: string;
  model: string;
  message: UnifiedMessage;
  finishReason: FinishReason;
  usage: UnifiedUsage;
}

/** One increment of a streamed response. The last chunk has `done: true`
 *  and carries `finishReason` + final `usage` (when the provider reports
 *  it); earlier chunks carry only their text delta. */
export interface UnifiedChatChunk {
  id: string;
  provider: string;
  model: string;
  delta: string;
  done: boolean;
  finishReason?: FinishReason;
  usage?: UnifiedUsage;
}

export interface ModelInfo {
  id: string;
  provider: string;
}

export interface LLMProvider {
  readonly name: string;
  /** Live catalog from the provider's own models-list endpoint (cached —
   *  see lib/modelsCache.ts), not a hardcoded array. Provider catalogs
   *  change too often for a static list baked into this codebase to stay
   *  current. Used for discovery (GET /v1/models) only — routing a chat
   *  request to a provider is a separate, synchronous prefix match (see
   *  providers/registry.ts) that doesn't depend on this. */
  models(): Promise<ModelInfo[]>;
  chat(req: UnifiedChatRequest): Promise<UnifiedChatResponse>;
  chatStream(req: UnifiedChatRequest): AsyncIterable<UnifiedChatChunk>;
}
