/** Public types for the CloudMesh SDK. These mirror the API's own Zod
 *  schemas (see packages/openapi, which generates the OpenAPI document from
 *  those same schemas) — if the two ever disagree, the server is right. */

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

export interface ChatParams {
  /** A concrete model id, or "auto" to let the routing engine score every
   *  candidate on cost, latency and reliability. An explicit model is never
   *  silently substituted. */
  model: string;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  /** Makes retries safe: an identical key returns the original result
   *  rather than issuing a second, separately-billed provider call. */
  idempotencyKey?: string;
  /** Aborts the in-flight request. */
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** Convenience sum computed by this SDK. The API returns only the two
   *  components; it does not send a total of its own. */
  totalTokens: number;
}

export interface ChatResponse {
  id: string;
  /** The model that actually served the request, which for "auto" may
   *  differ from what was asked for. */
  model: string;
  /** Which upstream served it, e.g. "openai", "anthropic", "mock". */
  provider: string;
  message: Message;
  usage: Usage;
  /** Why generation stopped, e.g. "stop" or "length". */
  finishReason?: string;
  /** True when served from the semantic cache. Cache hits are never
   *  billed — no new provider call happened. */
  cached?: boolean;
}

/**
 * One streamed delta. `text` is the increment, not the accumulated text.
 *
 * The wire format calls this field `delta`; the SDK exposes it as `text`
 * because that reads better at the call site (`process.stdout.write
 * (chunk.text)`) and matches the documented API. The mapping happens in
 * the client, so `delta` never leaks out.
 */
export interface ChatChunk {
  text: string;
  model?: string;
  provider?: string;
}

export interface ModelInfo {
  id: string;
  provider: string;
}

export type JobPriority = "CRITICAL" | "HIGH" | "NORMAL" | "LOW";
export type JobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "DEAD_LETTER";

export interface CreateJobParams {
  type: string;
  payload: unknown;
  priority?: JobPriority;
  signal?: AbortSignal;
}

export interface Job {
  id: string;
  type: string;
  status: JobStatus;
  progress: number;
  result?: unknown;
  error?: string;
  createdAt: string;
}

export interface ClientOptions {
  /** An API key created in the dashboard. The raw value is shown exactly
   *  once at creation — CloudMesh stores only a SHA-256 hash. */
  apiKey: string;
  /** Defaults to http://localhost:3001 for local development. */
  baseUrl?: string;
  /** Per-request timeout in ms. Default 60s — long enough for a slow
   *  completion, short enough that a hung connection doesn't leak. */
  timeoutMs?: number;
  /** Retries on 429 and 5xx only, honouring Retry-After. Default 2. */
  maxRetries?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}
