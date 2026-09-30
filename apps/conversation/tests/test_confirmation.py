from datetime import timedelta

from tests.conftest import open_tenant, proposal


def _confirm(world, tenant, actor, draft):
    return world.drafts.confirm(
        tenant.id,
        draft.id,
        actor_membership_id=actor.id,
        version=draft.version,
        content_hash_value=draft.content_hash,
        client=world.crm,
    )


def test_at04_replay_cancel_and_wrong_actor(world):
    tenant, _admin, sales = open_tenant(world, "acme", "acme-sales")
    other = world.identity.add_membership(
        tenant.id,
        display_name="Other",
        role="salesperson",
        channel="whatsapp",
        external_id="acme-other",
    )
    draft = world.drafts.open_proposal(tenant.id, sales.id, proposal())

    try:
        _confirm(world, tenant, other, draft)
        assert False
    except Exception as exc:
        assert exc.code == "forbidden"
    assert draft.state == "awaiting_confirmation"

    first = _confirm(world, tenant, sales, draft)
    creates = [name for name, _detail in world.crm.calls if name.startswith("create_")]
    replay = _confirm(world, tenant, sales, draft)
    assert replay.id == first.id
    assert [name for name, _detail in world.crm.calls if name.startswith("create_")] == creates
    assert not any(name.startswith("delete") for name, _detail in world.crm.calls)

    fresh = world.drafts.open_proposal(tenant.id, sales.id, proposal(email="second@example.com"))
    world.drafts.cancel(tenant.id, fresh.id, actor_membership_id=sales.id)
    assert fresh.state == "cancelled"
    try:
        _confirm(world, tenant, sales, fresh)
        assert False
    except Exception as exc:
        assert exc.code == "cancelled"


def test_confirmation_expires_after_thirty_minutes(world):
    tenant, _admin, sales = open_tenant(world, "acme", "acme-sales")
    draft = world.drafts.open_proposal(tenant.id, sales.id, proposal())
    world.clock.advance(timedelta(minutes=31))
    try:
        _confirm(world, tenant, sales, draft)
        assert False
    except Exception as exc:
        assert exc.code == "expired"
    assert draft.state == "expired"


def test_hash_mismatch_does_not_commit(world):
    tenant, _admin, sales = open_tenant(world, "acme", "acme-sales")
    draft = world.drafts.open_proposal(tenant.id, sales.id, proposal())
    try:
        world.drafts.confirm(
            tenant.id,
            draft.id,
            actor_membership_id=sales.id,
            version=draft.version,
            content_hash_value="0" * 64,
            client=world.crm,
        )
        assert False
    except Exception as exc:
        assert exc.code == "conflict"
    assert draft.state == "awaiting_confirmation"
    assert world.crm.calls == []
