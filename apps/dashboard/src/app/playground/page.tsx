import { redirect } from "next/navigation";
import NavShell from "../../components/NavShell";
import { getSession } from "../../lib/session";
import PlaygroundClient from "./PlaygroundClient";

export default async function PlaygroundPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <NavShell user={session.user}>
      <PlaygroundClient />
    </NavShell>
  );
}
