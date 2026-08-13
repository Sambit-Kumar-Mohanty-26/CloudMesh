import { CloudMeshError, ConnectionError, errorFromResponse, RateLimitError } from "./errors.js";
import type {
  ChatChunk,
  ChatParams,
  ChatResponse,
  ClientOptions,
  CreateJobParams,
  Job,
  Usage,
  ModelInfo,
} from "./types.js";

const DEFAULT_BASE_URL = "http://localhost:3001";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const SDK_VERSION = "0.1.0";

interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Streaming responses are handed back raw — the caller consumes the
   *  body itself rather than having it parsed as JSON. */
  raw?: boolean;
}

/**
 * Combines a caller-supplied AbortSignal with the client's own timeout, so
 * whichever fires first wins and neither leaks a timer.
 *
 * `AbortSignal.any` is Node 20+/modern browsers; this SDK's engines field
 * already requires Node >= 20.
 */
function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CloudMesh {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    if (!options?.apiKey) {
      throw new Error("CloudMesh: apiKey is required.");
    }
    this.#apiKey = options.apiKey;
    // Trailing slashes would produce //v1/chat, which some proxies treat as
    // a different path than /v1/chat.
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Never logged and never included in an error message — an API key in a
   *  stack trace is the most common way one ends up in a bug report. */
  #authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.#apiKey}`,
      "user-agent": `cloudmesh-sdk-js/${SDK_VERSION}`,
    };
  }

  async #request(options: RequestOptions): Promise<Response> {
    const url = `${this.#baseUrl}${options.path}`;
    let lastError: CloudMeshError | undefined;

    // attempt 0 is the initial call; subsequent iterations are retries.
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: options.method,
          headers: {
            ...this.#authHeaders(),
            ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
            ...options.headers,
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: withTimeout(this.#timeoutMs, options.signal),
        });
      } catch (err) {
        // A caller-initiated abort is intentional — surface it immediately
        // rather than burning retries on a request nobody is waiting for.
        if (options.signal?.aborted) {
          throw new ConnectionError("Request aborted by caller.", err);
        }
        lastError = new ConnectionError(
          err instanceof Error ? err.message : "Network request failed",
          err,
        );
        if (attempt < this.#maxRetries) {
          await sleep(2 ** attempt * 250);
          continue;
        }
        throw lastError;
      }

      if (response.ok) return response;

      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;

      // Read the error body once; a streaming response's body can only be
      // consumed a single time.
      let body: { error?: string; code?: string } | undefined;
      try {
        body = (await response.json()) as { error?: string; code?: string };
      } catch {
        body = undefined;
      }

      const error = errorFromResponse(
        response.status,
        body,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
        response.headers.get("x-request-id") ?? undefined,
      );

      // Only 429 and 5xx are worth retrying. A 400 or 401 will fail
      // identically forever, and retrying a 402 just hammers a budget
      // that is already exhausted.
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === this.#maxRetries) throw error;

      // Honour Retry-After when the server sent one; it knows when the
      // token bucket actually refills.
      const backoffMs =
        error instanceof RateLimitError && error.retryAfterSeconds !== undefined
          ? Math.ceil(error.retryAfterSeconds * 1000)
          : 2 ** attempt * 250;
      await sleep(backoffMs);
      lastError = error;
    }

    /* c8 ignore next -- unreachable: the loop always returns or throws. */
    throw lastError ?? new ConnectionError("Request failed.");
  }

  async #json<T>(options: RequestOptions): Promise<T> {
    const response = await this.#request(options);
    return (await response.json()) as T;
  }

  readonly chat = {
    /** A single, non-streaming completion. */
    create: async (params: ChatParams): Promise<ChatResponse> => {
      const { idempotencyKey, signal, ...body } = params;
      const raw = await this.#json<Omit<ChatResponse, "usage"> & { usage?: Partial<Usage> }>({
        method: "POST",
        path: "/v1/chat",
        body: { ...body, stream: false },
        headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined,
        signal,
      });

      // The API sends promptTokens/completionTokens but no total; summing
      // here means callers don't each reimplement it (and can't disagree
      // about whether a missing component counts as 0).
      const promptTokens = raw.usage?.promptTokens ?? 0;
      const completionTokens = raw.usage?.completionTokens ?? 0;

      return {
        ...raw,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
      };
    },

    /**
     * Streams the completion as it is generated.
     *
     * Returns an async iterable of deltas — `chunk.text` is the increment,
     * not the running total. The server sends SSE; this parses the framing
     * so callers never deal with `data:` lines or the `[DONE]` sentinel.
     */
    stream: (params: ChatParams): AsyncGenerator<ChatChunk, void, unknown> => {
      // An arrow function at class-property scope captures the instance
      // `this`; a `function*` would bind `this` to the `chat` object
      // literal instead, and every `this.#private` access would throw
      // "Receiver must be an instance of class CloudMesh".
      const request = this.#request.bind(this);

      return (async function* (): AsyncGenerator<ChatChunk, void, unknown> {
        const { idempotencyKey, signal, ...body } = params;
        const response = await request({
          method: "POST",
          path: "/v1/chat",
          body: { ...body, stream: true },
          headers: {
            accept: "text/event-stream",
            ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          },
          signal,
          raw: true,
        });

        if (!response.body) {
          throw new ConnectionError("Server returned no response body for a streaming request.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // SSE frames are separated by a blank line. A frame can arrive
            // split across chunks, so anything after the last separator
            // stays buffered until the rest shows up.
            const frames = buffer.split("\n\n");
            buffer = frames.pop() ?? "";

            for (const frame of frames) {
              const line = frame.split("\n").find((l) => l.startsWith("data:"));
              if (!line) continue;

              const payload = line.slice("data:".length).trim();
              if (payload === "[DONE]") return;
              if (!payload) continue;

              try {
                // The wire field is `delta`; the SDK's public field is
                // `text`. A terminal frame carries `done: true` and no
                // delta, so it is skipped — `[DONE]` above ends the stream.
                const parsed = JSON.parse(payload) as {
                  delta?: string;
                  model?: string;
                  provider?: string;
                };
                if (parsed.delta) {
                  yield { text: parsed.delta, model: parsed.model, provider: parsed.provider };
                }
              } catch {
                // A malformed frame is skipped rather than killing the
                // stream — the remaining tokens are still useful.
              }
            }
          }
        } finally {
          // Releases the underlying connection whether the consumer drained
          // the stream or broke out of the loop early.
          await reader.cancel().catch(() => undefined);
        }
      })();
    },
  };

  readonly models = {
    list: async (signal?: AbortSignal): Promise<ModelInfo[]> => {
      const res = await this.#json<{ models: ModelInfo[] }>({
        method: "GET",
        path: "/v1/models",
        signal,
      });
      return res.models ?? [];
    },
  };

  readonly jobs = {
    create: async (params: CreateJobParams): Promise<Job> => {
      const { signal, ...body } = params;
      return this.#json<Job>({ method: "POST", path: "/v1/jobs", body, signal });
    },

    get: async (id: string, signal?: AbortSignal): Promise<Job> =>
      this.#json<Job>({ method: "GET", path: `/v1/jobs/${encodeURIComponent(id)}`, signal }),

    list: async (
      params: { status?: Job["status"]; limit?: number; signal?: AbortSignal } = {},
    ): Promise<Job[]> => {
      const query = new URLSearchParams();
      if (params.status) query.set("status", params.status);
      if (params.limit !== undefined) query.set("limit", String(params.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";

      const res = await this.#json<{ jobs: Job[] }>({
        method: "GET",
        path: `/v1/jobs${suffix}`,
        signal: params.signal,
      });
      return res.jobs ?? [];
    },

    replay: async (id: string, signal?: AbortSignal): Promise<Job> =>
      this.#json<Job>({
        method: "POST",
        path: `/v1/jobs/${encodeURIComponent(id)}/replay`,
        signal,
      }),
  };
}
