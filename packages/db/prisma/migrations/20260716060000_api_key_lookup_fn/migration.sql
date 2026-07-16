-- API-key auth has to resolve a key hash to its org BEFORE the caller's
-- tenant context is known — that's the whole point of the lookup. Under
-- RLS with app.current_org unset, a plain SELECT from api_keys as the
-- cloudmesh_app role returns zero rows for every request, breaking auth
-- entirely. A SECURITY DEFINER function is the standard fix: it runs with
-- the privileges of its owner (the migration superuser, which bypasses RLS
-- unconditionally), so this one narrowly-scoped, read-only lookup can see
-- across tenants while every other query cloudmesh_app makes stays
-- RLS-bound. It returns only what auth needs — key_hash itself is not
-- echoed back, and no other columns are exposed.
CREATE FUNCTION lookup_api_key_by_hash(p_key_hash text)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  scopes text[],
  is_active boolean,
  rate_limit_rpm int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT id, org_id, scopes, is_active, rate_limit_rpm
  FROM api_keys
  WHERE key_hash = p_key_hash;
$$;

REVOKE ALL ON FUNCTION lookup_api_key_by_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_api_key_by_hash(text) TO cloudmesh_app;
