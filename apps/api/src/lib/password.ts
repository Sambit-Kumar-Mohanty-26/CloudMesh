import bcrypt from "bcryptjs";
import { env } from "../env.js";

const MIN_LENGTH = 8;
const MAX_LENGTH = 72; // bcrypt silently truncates beyond 72 bytes — reject instead.

export function validatePasswordStrength(password: string): string | null {
  if (password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters`;
  }
  if (password.length > MAX_LENGTH) {
    return `Password must be at most ${MAX_LENGTH} characters`;
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, env.BCRYPT_COST);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// A precomputed hash of a value nobody will ever type, used to keep the
// login timing path constant whether or not the account exists. Comparing
// against a bcrypt hash inline (rather than skipping the compare) is what
// actually costs the CPU time real user lookups cost.
const DUMMY_HASH = bcrypt.hashSync("cloudmesh-dummy-password-for-timing", 12);

export async function verifyPasswordConstantTime(
  password: string,
  hash: string | null,
): Promise<boolean> {
  if (!hash) {
    await bcrypt.compare(password, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(password, hash);
}
