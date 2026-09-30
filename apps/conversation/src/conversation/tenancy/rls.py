"""Postgres row-level security for the app database.

Applied by Alembic revision 0001_initial. Not executed on SQLite.
Policies compare tenant_id to current_setting('app.tenant_id', true), which
the service sets with set_config(..., is_local=true) at the start of a
PostgreSQL transaction.

conversation_app is NOSUPERUSER and has no BYPASSRLS. Table owners and
superusers still bypass RLS unless the API DSN is conversation_app; FORCE
ROW LEVEL SECURITY closes the owner hole, not the superuser hole.
"""

from __future__ import annotations

TENANT_SCOPED_TABLES = (
    "memberships",
    "channel_bindings",
    "enrollment_codes",
    "drafts",
    "operations",
    "operation_steps",
    "outbox",
    "schedules",
    "intake_sources",
    "intake_messages",
    "inbound_events",
    "audit_events",
    "conversation_references",
)


def helper_statements() -> list[str]:
    body = render_helper_sql()
    parts: list[str] = []
    current: list[str] = []
    for line in body.splitlines(keepends=True):
        current.append(line)
        if line.startswith("$$;"):
            parts.append("".join(current).strip())
            current = []
    tail = "".join(current).strip()
    if tail:
        for statement in tail.split(";"):
            chunk = statement.strip()
            if chunk:
                parts.append(chunk)
    return parts


def rls_statements() -> list[str]:
    """Individual SQL statements, safe to execute one at a time."""
    role = """
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'conversation_app') THEN
    CREATE ROLE conversation_app LOGIN PASSWORD 'conversation_app' NOSUPERUSER NOBYPASSRLS;
  ELSE
    ALTER ROLE conversation_app LOGIN PASSWORD 'conversation_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$
""".strip()
    statements = [role]
    statements.append(
        """
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO conversation_app', current_database());
END
$$
""".strip()
    )
    statements.extend(_policy_statements())
    statements.append(
        "GRANT USAGE ON SCHEMA public TO conversation_app"
    )
    statements.append(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO conversation_app"
    )
    statements.extend(helper_statements())
    return statements


def _policy_statements() -> list[str]:
    blocks = [
        """
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_tenant_isolation ON tenants;
CREATE POLICY tenants_tenant_isolation ON tenants
  USING (id::text = current_setting('app.tenant_id', true))
  WITH CHECK (id::text = current_setting('app.tenant_id', true))
""".strip()
    ]
    for table in TENANT_SCOPED_TABLES:
        blocks.append(
            f"""
ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE {table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};
CREATE POLICY {table}_tenant_isolation ON {table}
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true))
""".strip()
        )
    flattened: list[str] = []
    for block in blocks:
        for statement in block.split(";"):
            chunk = statement.strip()
            if chunk:
                flattened.append(chunk)
    return flattened


def render_helper_sql() -> str:
    """Security-definer lookups for rows the request cannot tenant-scope yet.

    Channel binding, intake alias, and enrollment codes are resolved before
    app.tenant_id is known. The functions return one row. They are owned by
    the migration role and do not accept a tenant id from the caller.
    """
    return """
CREATE OR REPLACE FUNCTION resolve_channel_binding(p_channel text, p_external_id text)
RETURNS TABLE (tenant_id uuid, membership_id uuid, binding_id uuid, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id, membership_id, id, status
  FROM channel_bindings
  WHERE channel = p_channel AND external_id = p_external_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION resolve_intake_alias(p_alias text)
RETURNS TABLE (tenant_id uuid, source_id uuid, mode text, actor_membership_id uuid, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id, id, mode, actor_membership_id, status
  FROM intake_sources
  WHERE alias = p_alias
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION resolve_enrollment_code(p_code_hash text)
RETURNS TABLE (tenant_id uuid, code_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id, id
  FROM enrollment_codes
  WHERE code_hash = p_code_hash AND consumed_at IS NULL
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION resolve_intake_source(p_source_id uuid)
RETURNS TABLE (tenant_id uuid, source_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id, id
  FROM intake_sources
  WHERE id = p_source_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION list_due_digests(p_now timestamptz)
RETURNS TABLE (tenant_id uuid, schedule_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id, id
  FROM schedules
  WHERE status = 'pending' AND kind = 'digest' AND next_run_at <= p_now
$$;

REVOKE ALL ON FUNCTION resolve_channel_binding(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_intake_alias(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_enrollment_code(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_intake_source(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_due_digests(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_channel_binding(text, text) TO conversation_app;
GRANT EXECUTE ON FUNCTION resolve_intake_alias(text) TO conversation_app;
GRANT EXECUTE ON FUNCTION resolve_enrollment_code(text) TO conversation_app;
GRANT EXECUTE ON FUNCTION resolve_intake_source(uuid) TO conversation_app;
GRANT EXECUTE ON FUNCTION list_due_digests(timestamptz) TO conversation_app;
""".strip()


def render_rls_sql() -> str:
    return ";\n\n".join(rls_statements()) + ";\n"
