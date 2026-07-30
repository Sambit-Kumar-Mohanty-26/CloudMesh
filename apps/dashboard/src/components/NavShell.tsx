import Link from "next/link";
import type { ReactNode } from "react";
import LogoutButton from "./LogoutButton";

const LINKS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/api-keys", label: "API Keys" },
  { href: "/dashboard/usage", label: "Usage" },
  { href: "/dashboard/logs", label: "Logs" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/playground", label: "Playground" },
];

export default function NavShell({
  user,
  children,
}: {
  user: { email: string; role: string };
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">CloudMesh</div>
        <nav>
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="user">
          <div>
            {user.email}
            <br />
            <span className="pill">{user.role}</span>
          </div>
          <LogoutButton />
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
