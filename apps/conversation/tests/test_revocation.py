import pytest

from conversation.models import EnrollmentCode
from tests.conftest import open_tenant, proposal


def test_at14_revocation_blocks_confirm(world):
    tenant, admin, sales = open_tenant(world, "acme", "acme-sales")
    draft = world.drafts.open_proposal(tenant.id, sales.id, proposal())
    world.identity.revoke(tenant.id, sales.id, admin.id)
    assert sales.status == "revoked"
    try:
        world.drafts.confirm(
            tenant.id,
            draft.id,
            actor_membership_id=sales.id,
            version=draft.version,
            content_hash_value=draft.content_hash,
            client=world.crm,
        )
        assert False
    except Exception as exc:
        assert exc.code == "forbidden"
    assert draft.state == "awaiting_confirmation"
    assert world.crm.calls == []


def test_enrollment_code_is_hashed_and_single_use(world):
    tenant, _admin, _sales = open_tenant(world, "acme", "acme-sales")
    code = world.identity.issue_enrollment_code(tenant.id, role="salesperson")
    membership = world.identity.redeem_enrollment_code(
        code=code,
        display_name="New",
        channel="teams",
        external_id="acme-new",
    )
    assert membership.role == "salesperson"
    stored = world.session.query(EnrollmentCode).one()
    assert stored.code_hash != code
    with pytest.raises(Exception) as caught:
        world.identity.redeem_enrollment_code(
            code=code,
            display_name="Again",
            channel="teams",
            external_id="acme-again",
        )
    assert caught.value.code == "invalid_code"


def test_daily_draft_quota(world):
    tenant = world.tenancy.create_tenant(
        name="capped",
        deployment_id="local",
        twenty_workspace_id="ws-capped",
        twenty_base_url="http://localhost:3000",
        twenty_api_key_ref="secret://tenants/capped/twenty-api-key",
        manifest_version="2026.1",
        daily_draft_quota=1,
    )
    sales = world.identity.add_membership(
        tenant.id,
        display_name="Sales",
        role="salesperson",
        channel="whatsapp",
        external_id="capped-sales",
    )
    world.drafts.open_proposal(tenant.id, sales.id, proposal())
    with pytest.raises(Exception) as caught:
        world.drafts.open_proposal(tenant.id, sales.id, proposal(email="other@example.com"))
    assert caught.value.code == "quota_exceeded"
