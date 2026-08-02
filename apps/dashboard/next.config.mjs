import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Phase 14: a self-contained server bundle (only the node_modules subset
  // this app actually needs, traced from its real imports) — the
  // Dockerfile's production stage copies just `.next/standalone` +
  // `.next/static` instead of the whole monorepo's node_modules.
  output: "standalone",
  // The user's home directory (d:\tmp, one level above this monorepo) has
  // an unrelated stray package-lock.json from a different project. Without
  // this, Next/Turbopack's root inference picks THAT as the workspace root
  // instead of this monorepo. Pointed at the monorepo root (not this app's
  // own directory) — that's where npm workspaces hoists `next` itself into
  // node_modules, which Turbopack needs to resolve from the root it's given.
  turbopack: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
  },
};

export default nextConfig;
