from tests.conftest import open_tenant


def _email(alias: str, message_id: str, stage: str = "NEW") -> str:
    return f"""To: intake+{alias}@intake.example
Message-Id: <{message_id}>

Name: Ada Lovelace
Email: ada@example.com
Company: Analytical Engines
Domain: engines.example
Stage: {stage}
Message: Met at the booth
"""


def test_at18_intake_dedupes_message_id(world):
    tenant, _admin, sales = open_tenant(world, "acme", "acme-sales")
    world.intake.add_source(tenant.id, alias="opaque-acme", mode="review", actor_membership_id=sales.id)
    raw = _email("opaque-acme", "msg-1")
    first = world.intake.receive(raw)
    second = world.intake.receive(raw)
    assert first.route == "review"
    assert second.duplicate is True
    assert second.intake_id == first.intake_id
    assert second.draft_id == first.draft_id
    assert world.intake.count_messages(tenant.id) == 1
    assert world.crm.calls == []


def test_at19_unknown_alias_does_not_open_a_draft(world):
    result = world.intake.receive(_email("missing-alias", "msg-9"))
    assert result.route == "unknown"
    assert result.draft_id is None
    assert world.intake.count_drafts() == 0
    assert world.crm.calls == []


def test_auto_intake_uses_the_journal_once(world):
    tenant, _admin, sales = open_tenant(world, "acme", "acme-sales")
    world.intake.add_source(tenant.id, alias="opaque-auto", mode="auto", actor_membership_id=sales.id)
    result = world.intake.receive(_email("opaque-auto", "msg-auto"))
    assert result.route == "committed"
    assert ("create_opportunity", "Analytical Engines — inbound") in world.crm.calls
    world.intake.receive(_email("opaque-auto", "msg-auto"))
    assert world.crm.calls.count(("create_opportunity", "Analytical Engines — inbound")) == 1


def test_invalid_stage_does_not_call_crm(world):
    tenant, _admin, sales = open_tenant(world, "acme", "acme-sales")
    world.intake.add_source(tenant.id, alias="opaque-bad", mode="auto", actor_membership_id=sales.id)
    result = world.intake.receive(_email("opaque-bad", "msg-bad", stage="NURTURE"))
    assert result.route == "needs_repair"
    assert world.crm.calls == []
