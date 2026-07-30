import { fetchOrRedirect } from "../../../lib/apiClient";
import { getSession } from "../../../lib/session";
import SettingsManager, { type BudgetStatus, type WebhookEndpoint } from "./SettingsManager";

export default async function SettingsPage() {
  const session = (await getSession())!;
  const [budget, webhooks] = await Promise.all([
    fetchOrRedirect<BudgetStatus>(session, "/billing/status"),
    fetchOrRedirect<WebhookEndpoint[]>(session, "/webhooks"),
  ]);

  return (
    <>
      <h1>Settings</h1>
      <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
        Signed in as <strong>{session.user.email}</strong> ({session.user.role})
      </p>
      <SettingsManager budget={budget} webhooks={webhooks} />
    </>
  );
}
