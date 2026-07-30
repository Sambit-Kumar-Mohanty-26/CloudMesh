import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import NavShell from "../../components/NavShell";
import { getSession } from "../../lib/session";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  return <NavShell user={session.user}>{children}</NavShell>;
}
