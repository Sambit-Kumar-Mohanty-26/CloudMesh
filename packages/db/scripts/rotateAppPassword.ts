/**
 * Rotates the `cloudmesh_app` role's password to a real secret.
 *
 * Why this exists as a script rather than a migration: the Phase 1
 * migration `20260715090000_app_role` creates the role with the literal
 * `PASSWORD 'cloudmesh_app'`, and its own comment says the credential
 * "moves into a secrets manager in Phase 2" — that follow-through never
 * happened. It can't happen inside a migration either: Prisma migrations
 * are static `.sql` files applied verbatim, with no way to interpolate an
 * environment variable, so the bootstrap password is necessarily a literal
 * in source. What was missing is the step that replaces it afterwards.
 *
 * Run this immediately after `migrate:deploy` in any environment that
 * isn't local dev (see k8s/15-migrate-job.yaml and k8s/DEPLOY.md). Local
 * docker-compose deliberately keeps the bootstrap password — it's a
 * throwaway credential on a throwaway database, and rotating it there
 * would just mean every developer's `.env` drifts from the seed data.
 *
 * Safety notes on the SQL below:
 *   - `ALTER ROLE ... PASSWORD` does not accept a bind parameter, so the
 *     value has to reach the statement as literal text. Rather than
 *     string-concatenating it (a SQL injection hole the moment a password
 *     contains a quote), the password is bound into a session GUC via
 *     `set_config($1, $2, true)` — a real parameterized call — and then
 *     quoted by Postgres itself with `format(%L)` inside a DO block.
 *   - `set_config(..., true)` is transaction-local, so the value is gone
 *     the moment the transaction ends; it never lands in a persistent
 *     setting another session could read.
 *   - The password never appears in this process's logs, and the script
 *     prints no part of it.
 *
 * This must run as the ADMIN (superuser) connection — `cloudmesh_app`
 * cannot ALTER its own role.
 */
import { getAdminPrisma, disconnectAll } from "../src/index.js";

/** Postgres truncates md5-auth passwords oddly past this, and anything
 *  shorter than 16 chars isn't worth calling a secret. */
const MIN_LENGTH = 16;

async function main(): Promise<void> {
  const password = process.env.APP_DB_PASSWORD;

  if (!password) {
    throw new Error(
      "APP_DB_PASSWORD is not set. Generate one with `openssl rand -base64 32` " +
        "and make sure it matches the password in APP_DATABASE_URL.",
    );
  }
  if (password.length < MIN_LENGTH) {
    throw new Error(`APP_DB_PASSWORD must be at least ${MIN_LENGTH} characters.`);
  }
  if (password === "cloudmesh_app") {
    throw new Error(
      "APP_DB_PASSWORD is still the bootstrap default. Set a real secret — " +
        "leaving it unchanged is the exact gap this script exists to close.",
    );
  }

  const admin = getAdminPrisma();

  await admin.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('cloudmesh.new_app_password', ${password}, true)`;
    await tx.$executeRawUnsafe(
      // No interpolation of user input here — the only dynamic value is
      // read back out of the transaction-local GUC set above and quoted by
      // Postgres's own `%L`, never by string concatenation in JS.
      `DO $$
       BEGIN
         EXECUTE format(
           'ALTER ROLE cloudmesh_app WITH PASSWORD %L',
           current_setting('cloudmesh.new_app_password')
         );
       END
       $$;`,
    );
  });

  // Deliberately does not echo the password or any prefix of it.
  // console.warn, not console.log: this is an operational script with no
  // pino logger available, and the repo's lint config only permits
  // error/warn (no-console) — see eslint.config.js.
  console.warn("cloudmesh_app password rotated. Update APP_DATABASE_URL to match.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectAll();
  });
