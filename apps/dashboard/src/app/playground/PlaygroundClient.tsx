"use client";

import Editor from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";

const DEFAULT_BODY = JSON.stringify(
  {
    model: "mock-echo",
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
    stream: true,
  },
  null,
  2,
);

const KEY_STORAGE = "cloudmesh_playground_api_key";

interface RunMeta {
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export default function PlaygroundClient() {
  const [apiKey, setApiKey] = useState("");
  const [requestBody, setRequestBody] = useState(DEFAULT_BODY);
  const [output, setOutput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<RunMeta | null>(null);

  useEffect(() => {
    const stored = window.sessionStorage.getItem(KEY_STORAGE);
    if (stored) setApiKey(stored);
  }, []);

  const abortRef = useRef<AbortController | null>(null);

  async function onRun() {
    setError(null);
    setOutput("");
    setMeta(null);

    if (!apiKey.trim()) {
      setError("Paste an API key first — the raw key is only ever shown once at creation.");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(requestBody);
    } catch {
      setError("Request body is not valid JSON.");
      return;
    }

    window.sessionStorage.setItem(KEY_STORAGE, apiKey);
    setRunning(true);
    const startedAt = performance.now();
    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/playground/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-cloudmesh-playground-key": apiKey },
        body: JSON.stringify(parsed),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Request failed (${res.status})`);
        setRunning(false);
        return;
      }

      const isStream = res.headers.get("content-type")?.includes("text/event-stream");
      if (!isStream) {
        const json = (await res.json()) as {
          model: string;
          provider: string;
          message: { content: string };
          usage: { promptTokens: number; completionTokens: number };
        };
        setOutput(json.message.content);
        setMeta({
          model: json.model,
          provider: json.provider,
          promptTokens: json.usage.promptTokens,
          completionTokens: json.usage.completionTokens,
          latencyMs: Math.round(performance.now() - startedAt),
        });
        setRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice("data: ".length);
          if (raw === "[DONE]") continue;
          const chunk = JSON.parse(raw) as {
            model: string;
            provider: string;
            delta: string;
            done: boolean;
            usage?: { promptTokens: number; completionTokens: number };
          };
          fullText += chunk.delta;
          setOutput(fullText);
          if (chunk.done && chunk.usage) {
            setMeta({
              model: chunk.model,
              provider: chunk.provider,
              promptTokens: chunk.usage.promptTokens,
              completionTokens: chunk.usage.completionTokens,
              latencyMs: Math.round(performance.now() - startedAt),
            });
          }
        }
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Request failed");
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <h1>API Playground</h1>
      <div className="field" style={{ maxWidth: 480 }}>
        API key
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="cm_live_..."
        />
      </div>
      <p style={{ color: "var(--muted)", fontSize: "0.8rem", maxWidth: 480 }}>
        Pasted keys are kept only in this tab&apos;s session storage, never sent anywhere except
        this request.
      </p>

      <div className="playground">
        <div className="panel">
          <div className="panel-header">
            <span>Request</span>
            <button type="button" onClick={onRun} disabled={running}>
              {running ? "Running..." : "Run"}
            </button>
          </div>
          <Editor
            height="100%"
            defaultLanguage="json"
            theme="vs-dark"
            value={requestBody}
            onChange={(v) => setRequestBody(v ?? "")}
            options={{ minimap: { enabled: false }, fontSize: 13 }}
          />
        </div>
        <div className="panel">
          <div className="panel-header">
            <span>Response</span>
          </div>
          <div className="output">
            {error ? <span style={{ color: "var(--danger)" }}>{error}</span> : output}
          </div>
          {meta && (
            <div className="meta">
              <span>model: {meta.model}</span>
              <span>provider: {meta.provider}</span>
              <span>
                tokens: {meta.promptTokens}+{meta.completionTokens}
              </span>
              <span>latency: {meta.latencyMs}ms</span>
              <span title="Billed cost is computed and recorded server-side — see Logs for the exact figure.">
                cost: see Logs
              </span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
