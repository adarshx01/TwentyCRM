import pytest

from conversation.models import Operation, OperationStep
from tests.conftest import open_tenant, proposal


def test_at13_journal_resumes_without_recreating_or_deleting(world):
    tenant, _admin, sales = open_tenant(world, "acme", "acme-sales")
    action = proposal()
    draft = world.drafts.open_proposal(tenant.id, sales.id, action)
    operation = Operation(
        tenant_id=tenant.id,
        draft_id=draft.id,
        actor_membership_id=sales.id,
        idempotency_key="resume-test",
        status="running",
    )
    world.session.add(operation)
    world.session.flush()

    world.crm.fail_steps.add("opportunity")
    with pytest.raises(Exception):
        world.journal.execute(operation, action, world.crm)
    steps = {
        step.step_key: step
        for step in world.session.query(OperationStep).filter_by(operation_id=operation.id)
    }
    assert steps["company"].status == "completed"
    assert steps["person"].status == "completed"
    person_id = steps["person"].external_id
    company_id = steps["company"].external_id
    assert steps["opportunity"].status == "failed"

    world.crm.fail_steps.clear()
    world.journal.execute(operation, action, world.crm)
    assert operation.status == "completed"
    creates = [call for call in world.crm.calls if call[0] == "create_person"]
    assert creates == [("create_person", "ada@example.com")]
    assert [call for call in world.crm.calls if call[0] == "create_company"] == [
        ("create_company", "engines.example")
    ]
    assert not any(call[0].startswith("delete") for call in world.crm.calls)
    assert steps["person"].external_id == person_id
    assert steps["company"].external_id == company_id
    assert steps["opportunity"].status == "completed"
    assert steps["note"].status == "completed"
    assert steps["task"].status == "completed"


def test_existing_person_is_reused(world):
    tenant, _admin, sales = open_tenant(world, "acme", "acme-sales")
    world.crm.people["ada@example.com"] = "person_existing"
    draft = world.drafts.open_proposal(tenant.id, sales.id, proposal())
    world.drafts.confirm(
        tenant.id,
        draft.id,
        actor_membership_id=sales.id,
        version=draft.version,
        content_hash_value=draft.content_hash,
        client=world.crm,
    )
    assert ("create_person", "ada@example.com") not in world.crm.calls
    assert ("find_person", "ada@example.com") in world.crm.calls

