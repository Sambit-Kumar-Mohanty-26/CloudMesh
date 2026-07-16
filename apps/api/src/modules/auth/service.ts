import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@cloudmesh/db";
import type { Redis } from "ioredis";
import { ConflictError, UnauthorizedError, ValidationError } from "../../errors.js";
import {
  InvalidTokenError,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../lib/jwt.js";
import {
  hashPassword,
  validatePasswordStrength,
  verifyPasswordConstantTime,
} from "../../lib/password.js";

export interface AuthDeps {
  db: PrismaClient;
  redis: Redis;
}

const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 7;
const refreshKey = (jti: string) => `refresh:${jti}`;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

async function issueTokenPair(
  redis: Redis,
  userId: string,
  orgId: string,
  role: string,
): Promise<TokenPair> {
  const jti = randomUUID();
  const accessToken = signAccessToken({ sub: userId, orgId, role });
  const refreshToken = signRefreshToken({ sub: userId, orgId, jti });
  // Value doubles as a cheap sanity check on refresh/logout; the source of
  // truth for "is this refresh token still valid" is simply key existence.
  await redis.set(refreshKey(jti), userId, "EX", REFRESH_TTL_SECONDS);
  return { accessToken, refreshToken };
}

export async function register(
  { db }: AuthDeps,
  input: { orgName: string; email: string; password: string },
): Promise<{ orgId: string; userId: string }> {
  const strengthError = validatePasswordStrength(input.password);
  if (strengthError) {
    throw new ValidationError(strengthError);
  }

  const existing = await db.user.findUnique({ where: { email: input.email } });
  if (existing) {
    // Unlike login, register legitimately needs to tell the caller the
    // email is taken (there's no useful "generic" register error) —
    // this is expected UX, not the same enumeration risk as login.
    throw new ConflictError("Email is already registered");
  }

  const passwordHash = await hashPassword(input.password);

  const result = await db.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: input.orgName,
        featureFlags: {
          semantic_cache: false,
          streaming: false,
          rate_limit_rpm: 60,
          allowed_models: [],
          request_dedup: false,
        },
      },
    });
    const user = await tx.user.create({
      data: {
        email: input.email,
        passwordHash,
        role: "OWNER",
        orgId: org.id,
      },
    });
    return { orgId: org.id, userId: user.id };
  });

  return result;
}

export async function login(
  { db, redis }: AuthDeps,
  input: { email: string; password: string },
): Promise<TokenPair & { user: { id: string; email: string; role: string; orgId: string } }> {
  const user = await db.user.findUnique({ where: { email: input.email } });

  const valid = await verifyPasswordConstantTime(input.password, user?.passwordHash ?? null);

  // Identical error for "no such user" and "wrong password" — and the
  // constant-time compare above already ran a real bcrypt comparison on
  // both paths, so this branch doesn't introduce a timing gap either.
  if (!user || !valid) {
    throw new UnauthorizedError("Invalid email or password");
  }

  const tokens = await issueTokenPair(redis, user.id, user.orgId, user.role);
  return {
    ...tokens,
    user: { id: user.id, email: user.email, role: user.role, orgId: user.orgId },
  };
}

export async function refresh({ db, redis }: AuthDeps, refreshToken: string): Promise<TokenPair> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      throw new UnauthorizedError("Invalid or expired refresh token");
    }
    throw err;
  }

  const stored = await redis.get(refreshKey(payload.jti));
  // Missing key means: never issued, already used (rotation deletes it), or
  // explicitly revoked via logout. All three are correctly "reject" — a
  // replayed, already-rotated refresh token fails here, which is the reuse
  // detection this scheme relies on.
  if (!stored || stored !== payload.sub) {
    throw new UnauthorizedError("Refresh token has been revoked");
  }

  // Rotate first: the old token must not work again even if something
  // below fails or the response is lost.
  await redis.del(refreshKey(payload.jti));

  // Re-derive role/orgId from the DB rather than trusting the token's own
  // claims — a refresh token can be a week old, and a role change or
  // deactivation since it was issued must take effect immediately.
  const user = await db.user.findUnique({ where: { id: payload.sub } });
  if (!user) {
    throw new UnauthorizedError("Account no longer exists");
  }

  return issueTokenPair(redis, user.id, user.orgId, user.role);
}

export async function logout({ redis }: AuthDeps, refreshToken: string): Promise<void> {
  try {
    const payload = verifyRefreshToken(refreshToken);
    await redis.del(refreshKey(payload.jti));
  } catch {
    // Logout is idempotent — an already-invalid token is not an error.
  }
}
