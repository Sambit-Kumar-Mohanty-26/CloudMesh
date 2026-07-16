import type { FastifyRequest } from "fastify";
import { UnauthorizedError } from "../errors.js";
import { verifyAccessToken, type AccessTokenPayload } from "../lib/jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: AccessTokenPayload;
  }
}

export async function requireJwt(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or malformed Authorization header");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw new UnauthorizedError("Missing or malformed Authorization header");
  }

  try {
    request.user = verifyAccessToken(token);
  } catch {
    throw new UnauthorizedError("Invalid or expired token");
  }
}
