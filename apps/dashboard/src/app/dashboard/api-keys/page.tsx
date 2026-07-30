import { fetchOrRedirect } from "../../../lib/apiClient";
import { getSession } from "../../../lib/session";
import ApiKeysManager, { type ApiKeySummary } from "./ApiKeysManager";

export default async function ApiKeysPage() {
  const session = (await getSession())!;
  const keys = await fetchOrRedirect<ApiKeySummary[]>(session, "/api-keys");

  return (
    <>
      <h1>API Keys</h1>
      <ApiKeysManager initialKeys={keys} />
    </>
  );
}
