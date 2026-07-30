import { fetchOrRedirect } from "../../lib/apiClient";
import { getSession } from "../../lib/session";

interface BudgetStatus {
  spentUsd: number;
  budgetUsd: number | null;
  remainingUsd: number | null;
  remainingFraction: number;
}

interface AnalyticsSummary {
  totals: { requests: number; tokens: number; costUsd: number };
  buckets: { bucket: string; requests: number }[];
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default async function OverviewPage() {
  const session = (await getSession())!;
  const [budget, analytics] = await Promise.all([
    fetchOrRedirect<BudgetStatus>(session, "/billing/status"),
    fetchOrRedirect<AnalyticsSummary>(session, "/analytics?period=7d"),
  ]);

  const avgPerRequest =
    analytics.totals.requests > 0 ? analytics.totals.costUsd / analytics.totals.requests : 0;

  return (
    <>
      <h1>Overview</h1>
      <div className="card-grid">
        <div className="card">
          <div className="label">Requests (7d)</div>
          <div className="value">{analytics.totals.requests.toLocaleString()}</div>
        </div>
        <div className="card">
          <div className="label">Tokens (7d)</div>
          <div className="value">{analytics.totals.tokens.toLocaleString()}</div>
        </div>
        <div className="card">
          <div className="label">Cost (7d)</div>
          <div className="value">{money(analytics.totals.costUsd)}</div>
        </div>
        <div className="card">
          <div className="label">Avg cost / request</div>
          <div className="value">{money(avgPerRequest)}</div>
        </div>
        <div className="card">
          <div className="label">This month's spend</div>
          <div className="value">{money(budget.spentUsd)}</div>
        </div>
        <div className="card">
          <div className="label">Budget remaining</div>
          <div className="value">
            {budget.budgetUsd === null
              ? "Unlimited"
              : `${money(Math.max(budget.remainingUsd ?? 0, 0))} of ${money(budget.budgetUsd)}`}
          </div>
        </div>
      </div>

      <h2>Recent activity</h2>
      {analytics.buckets.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No requests in the last 7 days yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Hour</th>
              <th>Requests</th>
            </tr>
          </thead>
          <tbody>
            {analytics.buckets
              .slice(-10)
              .reverse()
              .map((b) => (
                <tr key={b.bucket}>
                  <td>{new Date(b.bucket).toLocaleString()}</td>
                  <td>{b.requests}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </>
  );
}
