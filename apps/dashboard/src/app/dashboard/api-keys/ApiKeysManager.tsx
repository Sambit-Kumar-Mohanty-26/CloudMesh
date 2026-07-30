"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface ApiKeySummary {
  id: string;
  keyPrefix: string;
  scopes: string[];
  isActive: boolean;
  rateLimitRpm: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export default function ApiKeysManager({ initialKeys }: { initialKeys: ApiKeySummary[] }) {
  const router = useRouter();
  const [scopes, setScopes] = useState("chat:write");
  const [rateLimitRpm, setRateLimitRpm] = useState("60");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setRawKey(null);

    const res = await fetch("/api/proxy/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scopes: scopes
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        rateLimitRpm: Number(rateLimitRpm) || undefined,
      }),
    });

    setCreating(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Failed to create key");
      return;
    }

    const created = (await res.json()) as { rawKey: string };
    setRawKey(created.rawKey);
    router.refresh();
  }

  async function onRevoke(id: string) {
    setRevokingId(id);
    await fetch(`/api/proxy/api-keys/${id}`, { method: "DELETE" });
    setRevokingId(null);
    router.refresh();
  }

  return (
    <>
      <form onSubmit={onCreate} className="toolbar" style={{ alignItems: "flex-end" }}>
        <div className="field">
          Scopes (comma-separated)
          <input value={scopes} onChange={(e) => setScopes(e.target.value)} />
        </div>
        <div className="field">
          Rate limit (rpm)
          <input
            type="number"
            min={1}
            value={rateLimitRpm}
            onChange={(e) => setRateLimitRpm(e.target.value)}
          />
        </div>
        <button type="submit" disabled={creating}>
          {creating ? "Creating..." : "Create key"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {rawKey && (
        <div className="raw-key-box">
          <strong>Your new API key (shown once):</strong>
          <br />
          {rawKey}
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>Prefix</th>
            <th>Scopes</th>
            <th>Rate limit</th>
            <th>Status</th>
            <th>Last used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {initialKeys.map((key) => (
            <tr key={key.id}>
              <td>{key.keyPrefix}...</td>
              <td>{key.scopes.join(", ")}</td>
              <td>{key.rateLimitRpm}/min</td>
              <td>
                <span className={`pill ${key.isActive ? "ok" : "bad"}`}>
                  {key.isActive ? "active" : "revoked"}
                </span>
              </td>
              <td>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "never"}</td>
              <td>
                {key.isActive && (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => onRevoke(key.id)}
                    disabled={revokingId === key.id}
                  >
                    {revokingId === key.id ? "Revoking..." : "Revoke"}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {initialKeys.length === 0 && (
            <tr>
              <td colSpan={6} style={{ color: "var(--muted)" }}>
                No API keys yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
