import { fetchOrRedirect } from "../../../lib/apiClient";
import { getSession } from "../../../lib/session";

interface LogEntry {
  id: string;
  createdAt: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  requestId: string;
}

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ model?: string }>;
}) {
  const session = (await getSession())!;
  const params = await searchParams;
  const qs = params.model ? `?model=${encodeURIComponent(params.model)}` : "";
  const logs = await fetchOrRedirect<LogEntry[]>(session, `/analytics/logs${qs}`);

  return (
    <>
      <h1>Request Logs</h1>
      <p style={{ color: "var(--muted)", fontSize: "0.85rem", maxWidth: 640 }}>
        Each row is a billed request (from <code>usage_records</code>) — the durable, queryable
        per-request record this codebase persists. Full request/response detail (status code,
        headers, error text) lives in traces and structured logs instead, not here; use Jaeger for
        one specific failing request.
      </p>
      <form method="get" className="toolbar">
        <div className="field" style={{ marginBottom: 0 }}>
          Filter by model
          <input name="model" defaultValue={params.model ?? ""} placeholder="gpt-4o" />
        </div>
        <button type="submit">Filter</button>
        {params.model && (
          <a href="/dashboard/logs">
            <button type="button" className="secondary">
              Clear
            </button>
          </a>
        )}
      </form>

      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Model</th>
            <th>Prompt tokens</th>
            <th>Completion tokens</th>
            <th>Cost</th>
            <th>Request ID</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr key={log.id}>
              <td>{new Date(log.createdAt).toLocaleString()}</td>
              <td>{log.model}</td>
              <td>{log.promptTokens}</td>
              <td>{log.completionTokens}</td>
              <td>${log.costUsd.toFixed(4)}</td>
              <td style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.75rem" }}>
                {log.requestId}
              </td>
            </tr>
          ))}
          {logs.length === 0 && (
            <tr>
              <td colSpan={6} style={{ color: "var(--muted)" }}>
                No requests found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
