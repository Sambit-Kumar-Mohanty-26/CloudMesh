/**
 * Parses a standard `data: {...}\n\n`-framed SSE response body into raw
 * payload strings (the part after `data: `), one per event. Used by any
 * adapter whose provider streams in this shape (OpenAI, Anthropic, and
 * Gemini via its `alt=sse` query param) — providers with a different wire
 * format (Ollama's NDJSON) parse it themselves instead.
 */
export async function* parseSSELines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.startsWith("data:")) {
          yield line.slice("data:".length).trim();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Parses newline-delimited JSON (one full JSON object per line) — Ollama's
 *  streaming format. */
export async function* parseNDJSONLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) yield line;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
