import jwt from "jsonwebtoken";
import { env } from "../env.js";

const ALGORITHM = "HS256" as const;
const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface AccessTokenPayload {
  sub: string; // user id
  orgId: string;
  role: string;
}

export interface RefreshTokenPayload {
  sub: string; // user id
  orgId: string;
  jti: string; // unique id, tracked in Redis for rotation + reuse detection
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: REFRESH_TOKEN_TTL_SECONDS,
  });
}

export class InvalidTokenError extends Error {
  constructor(message = "Invalid or expired token") {
    super(message);
    this.name = "InvalidTokenError";
  }
}

/**
 * Verifies a token against the current signing secret, falling back to the
 * previous one during a rotation window. `algorithms: [ALGORITHM]` is
 * mandatory here: without an explicit allowlist, jsonwebtoken (like most
 * JWT libraries) will trust the algorithm named in the token's own header,
 * which is exactly the "alg: none" / algorithm-confusion class of attack.
 * Never remove this option, and never derive the algorithm from the token.
 */
function verifyWithRotation<T extends object>(token: string): T {
  try {
    return jwt.verify(token, env.JWT_SECRET, {
      algorithms: [ALGORITHM],
    }) as T;
  } catch (firstErr) {
    if (env.JWT_SECRET_PREVIOUS) {
      try {
        return jwt.verify(token, env.JWT_SECRET_PREVIOUS, {
          algorithms: [ALGORITHM],
        }) as T;
      } catch {
        // fall through to the original error below
      }
    }
    throw new InvalidTokenError(firstErr instanceof Error ? firstErr.message : "Invalid token");
  }
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return verifyWithRotation<AccessTokenPayload>(token);
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return verifyWithRotation<RefreshTokenPayload>(token);
}
