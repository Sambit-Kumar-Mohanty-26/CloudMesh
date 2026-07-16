import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_DATABASE_URL: z.string().url(),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_SECRET_PREVIOUS: z
    .string()
    .min(32)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),
});

// Fail fast at boot: a service with a missing/weak JWT secret should never
// come up and start accepting traffic.
export const env = schema.parse(process.env);
export type Env = typeof env;
