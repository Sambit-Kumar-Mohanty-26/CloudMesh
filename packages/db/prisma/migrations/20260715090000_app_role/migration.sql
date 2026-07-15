-- The role Prisma migrates with (from POSTGRES_USER) is the database's
-- bootstrap superuser, and superusers bypass Row-Level Security entirely —
-- FORCE ROW LEVEL SECURITY has no effect on them. RLS is only real if the
-- application connects as a non-superuser role, so that role is created
-- here. This is a local-dev credential (mirrors docker-compose.yml); in
-- Phase 2 the app's connection secret moves into a secrets manager.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cloudmesh_app') THEN
    CREATE ROLE cloudmesh_app WITH LOGIN PASSWORD 'cloudmesh_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO cloudmesh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cloudmesh_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cloudmesh_app;
