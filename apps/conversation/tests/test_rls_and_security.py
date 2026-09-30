from conversation.db import bind_tenant
from conversation.models import Base
from conversation.tenancy.rls import TENANT_SCOPED_TABLES, render_rls_sql


def test_rls_sql_covers_every_tenant_table():
    sql = render_rls_sql()
    tables = set(Base.metadata.tables)
    assert "tenants" in tables
    for table in TENANT_SCOPED_TABLES:
        assert table in tables
        assert f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY" in sql
        assert f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY" in sql
        assert f"CREATE POLICY {table}_tenant_isolation" in sql
        assert "current_setting('app.tenant_id', true)" in sql
    assert "ALTER TABLE tenants FORCE ROW LEVEL SECURITY" in sql
    assert "resolve_channel_binding" in sql
    assert "SECURITY DEFINER" in sql
    assert "NOBYPASSRLS" in sql
    owned = {table for table in tables if table != "tenants"}
    assert owned == set(TENANT_SCOPED_TABLES)


def test_bind_tenant_is_a_noop_on_sqlite(world):
    tenant, _admin, _sales = __import__("tests.conftest", fromlist=["open_tenant"]).open_tenant(
        world, "acme", "acme-sales"
    )
    bind_tenant(world.session, tenant.id)


def test_admin_rejects_raw_api_keys():
    from pydantic import ValidationError

    from conversation.admin.schemas import CreateTenantBody

    try:
        CreateTenantBody(
            name="Acme",
            deployment_id="local",
            twenty_workspace_id="ws",
            twenty_base_url="http://localhost:3000",
            twenty_api_key_ref="super-secret-key",
        )
        assert False
    except ValidationError:
        pass
    body = CreateTenantBody(
        name="Acme",
        deployment_id="local",
        twenty_workspace_id="ws",
        twenty_base_url="http://localhost:3000",
        twenty_api_key_ref="secret://tenants/acme/twenty-api-key",
    )
    assert body.twenty_api_key_ref.startswith("secret://")
