from tests.conftest import open_tenant, proposal


def test_at02_role_scope_at_commit(world):
    tenant, admin, sales = open_tenant(world, "acme", "acme-sales")
    other = world.identity.add_membership(
        tenant.id,
        display_name="Other",
        role="salesperson",
        channel="whatsapp",
        external_id="acme-other",
    )
    manager = world.identity.add_membership(
        tenant.id,
        display_name="Manager",
        role="manager",
        channel="teams",
        external_id="acme-manager",
    )
    cxo = world.identity.add_membership(tenant.id, display_name="CXO", role="cxo")
    draft = world.drafts.open_proposal(tenant.id, sales.id, proposal())

    for actor, code in ((other, "forbidden"), (cxo, "forbidden"), (admin, "forbidden")):
        try:
            world.drafts.confirm(
                tenant.id,
                draft.id,
                actor_membership_id=actor.id,
                version=draft.version,
                content_hash_value=draft.content_hash,
                client=world.crm,
            )
            assert False, actor.role
        except Exception as exc:
            assert exc.code == code

    operation = world.drafts.confirm(
        tenant.id,
        draft.id,
        actor_membership_id=manager.id,
        version=draft.version,
        content_hash_value=draft.content_hash,
        client=world.crm,
    )
    assert operation.status == "completed"
    assert draft.state == "committed"
    assert world.crm.calls.count(("create_person", "ada@example.com")) == 1
