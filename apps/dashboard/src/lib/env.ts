// Server-side only — these point at internal services, never sent to the
// browser. Defaults match this repo's docker-compose/local dev ports.
export const API_BASE_URL = process.env.CLOUDMESH_API_URL ?? "http://localhost:3000";
export const GATEWAY_BASE_URL = process.env.CLOUDMESH_GATEWAY_URL ?? "http://localhost:3001";

export const SESSION_COOKIE = "cm_dashboard_session";
