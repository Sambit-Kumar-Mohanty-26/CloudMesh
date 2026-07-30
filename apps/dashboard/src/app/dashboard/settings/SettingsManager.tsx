"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface BudgetStatus {
  spentUsd: number;
  budgetUsd: number | null;
  remainingUsd: number | null;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  eventTypes: string[];
  isActive: boolean;
  createdAt: string;
}

// Kept in sync with packages/webhooks' WEBHOOK_EVENT_TYPES (Phase 11) —
// there's no GET endpoint exposing this list live, so it's a documented
// duplicate, the same trade-off as any client-side enum mirroring a
// backend one.
const EVENT_TYPES = [
  "job.completed",
  "job.failed",
  "budget.warning",
  "budget.exceeded",
  "api_key.created",
  "api_key.revoked",
  "request.rate_limited",
  "provider.degraded",
];

export default function SettingsManager({
  budget,
  webhooks,
}: {
  budget: BudgetStatus;
  webhooks: WebhookEndpoint[];
}) {
  const router = useRouter();
  const [budgetInput, setBudgetInput] = useState(budget.budgetUsd?.toString() ?? "");
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [savingBudget, setSavingBudget] = useState(false);

  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  async function onSaveBudget(e: React.FormEvent) {
    e.preventDefault();
    setSavingBudget(true);
    setBudgetError(null);
    const res = await fetch("/api/proxy/billing/budget", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        monthlyBudgetOverrideUsd: budgetInput.trim() === "" ? null : Number(budgetInput),
      }),
    });
    setSavingBudget(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setBudgetError(body.error ?? "Failed to update budget");
      return;
    }
    router.refresh();
  }

  function toggleEvent(type: string) {
    setSelectedEvents((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }

  async function onRegisterWebhook(e: React.FormEvent) {
    e.preventDefault();
    setRegistering(true);
    setWebhookError(null);
    setNewSecret(null);
    const res = await fetch("/api/proxy/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, eventTypes: selectedEvents }),
    });
    setRegistering(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setWebhookError(body.error ?? "Failed to register webhook");
      return;
    }
    const created = (await res.json()) as { secret: string };
    setNewSecret(created.secret);
    setUrl("");
    setSelectedEvents([]);
    router.refresh();
  }

  async function onDeleteWebhook(id: string) {
    await fetch(`/api/proxy/webhooks/${id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <>
      <h2>Budget</h2>
      <form onSubmit={onSaveBudget} className="toolbar" style={{ alignItems: "flex-end" }}>
        <div className="field">
          Monthly budget override (USD, blank = plan default)
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value)}
            placeholder="unlimited"
          />
        </div>
        <button type="submit" disabled={savingBudget}>
          {savingBudget ? "Saving..." : "Save"}
        </button>
      </form>
      {budgetError && <p className="error">{budgetError}</p>}

      <h2>Webhooks</h2>
      <form onSubmit={onRegisterWebhook}>
        <div className="field">
          Endpoint URL
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/webhooks/cloudmesh"
            required
          />
        </div>
        <div className="field">
          Event types
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
            {EVENT_TYPES.map((type) => (
              <label
                key={type}
                className="pill"
                style={{
                  cursor: "pointer",
                  background: selectedEvents.includes(type) ? "var(--accent)" : undefined,
                }}
              >
                <input
                  type="checkbox"
                  checked={selectedEvents.includes(type)}
                  onChange={() => toggleEvent(type)}
                  style={{ marginRight: "0.3rem" }}
                />
                {type}
              </label>
            ))}
          </div>
        </div>
        <button type="submit" disabled={registering || selectedEvents.length === 0}>
          {registering ? "Registering..." : "Register webhook"}
        </button>
      </form>
      {webhookError && <p className="error">{webhookError}</p>}
      {newSecret && (
        <div className="raw-key-box">
          <strong>Signing secret (shown once):</strong>
          <br />
          {newSecret}
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>URL</th>
            <th>Events</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {webhooks.map((wh) => (
            <tr key={wh.id}>
              <td style={{ maxWidth: 260, overflowWrap: "break-word" }}>{wh.url}</td>
              <td style={{ fontSize: "0.75rem" }}>{wh.eventTypes.join(", ")}</td>
              <td>
                <span className={`pill ${wh.isActive ? "ok" : "bad"}`}>
                  {wh.isActive ? "active" : "inactive"}
                </span>
              </td>
              <td>
                <button type="button" className="danger" onClick={() => onDeleteWebhook(wh.id)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {webhooks.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: "var(--muted)" }}>
                No webhook endpoints registered.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
