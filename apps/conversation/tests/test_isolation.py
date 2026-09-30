from tests.conftest import open_tenant, proposal


def test_at01_two_tenants_do_not_cross_read(world):
    tenant_a, _admin_a, sales_a = open_tenant(world, "alpha", "alpha-phone")
    tenant_b, _admin_b, sales_b = open_tenant(world, "beta", "beta-phone")
    draft_a = world.drafts.open_proposal(tenant_a.id, sales_a.id, proposal(email="a@alpha.example"))
    draft_b = world.drafts.open_proposal(tenant_b.id, sales_b.id, proposal(email="b@beta.example"))

    visible = {row.id for row in world.drafts.list_drafts(tenant_a.id)}
    assert visible == {draft_a.id}
    assert draft_b.id not in visible

    try:
        world.drafts.get(tenant_a.id, draft_b.id)
        raised = False
    except Exception as exc:
        raised = True
        assert exc.code == "not_found"
    assert raised

    try:
        world.drafts.confirm(
            tenant_a.id,
            draft_b.id,
            actor_membership_id=sales_a.id,
            version=draft_b.version,
            content_hash_value=draft_b.content_hash,
            client=world.crm,
        )
        confirmed = True
    except Exception as exc:
        confirmed = False
        assert exc.code == "not_found"
    assert confirmed is False
