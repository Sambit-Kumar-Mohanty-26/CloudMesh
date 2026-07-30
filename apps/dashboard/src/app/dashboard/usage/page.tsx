import { fetchOrRedirect } from "../../../lib/apiClient";
import { getSession } from "../../../lib/session";
import UsageCharts, { type HourlyBucket, type ModelBreakdown } from "./UsageCharts";

interface AnalyticsSummary {
  buckets: HourlyBucket[];
  byModel: ModelBreakdown[];
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const session = (await getSession())!;
  const params = await searchParams;
  const period = ["24h", "7d", "30d"].includes(params.period ?? "") ? params.period : "7d";
  const analytics = await fetchOrRedirect<AnalyticsSummary>(session, `/analytics?period=${period}`);

  return (
    <>
      <h1>Usage</h1>
      <div className="toolbar">
        {(["24h", "7d", "30d"] as const).map((p) => (
          <a key={p} href={`/dashboard/usage?period=${p}`}>
            <button type="button" className={p === period ? "" : "secondary"}>
              {p}
            </button>
          </a>
        ))}
      </div>
      {analytics.buckets.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No usage in this period yet.</p>
      ) : (
        <UsageCharts buckets={analytics.buckets} byModel={analytics.byModel} />
      )}
    </>
  );
}
