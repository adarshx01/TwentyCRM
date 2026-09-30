import pytest
from pydantic import ValidationError

from conversation.crm.proposal import proposal_from_card
from tests.conftest import open_tenant, proposal, sample_card


def test_at06_unknown_stage_is_rejected(world):
    tenant, _admin, sales = open_tenant(world, "acme", "acme-sales")
    with pytest.raises(Exception) as caught:
        world.drafts.open_proposal(tenant.id, sales.id, proposal(stage="NURTURE"))
    assert caught.value.code == "invalid_stage"
    assert world.drafts.list_drafts(tenant.id) == []
    assert world.crm.calls == []


def test_at07_invented_fields_are_rejected():
    card = sample_card()
    card["person"]["favoriteColor"] = "blue"
    with pytest.raises(ValidationError):
        proposal_from_card(card)


def test_tenant_id_on_a_card_is_not_a_routing_field():
    card = sample_card()
    card["tenant_id"] = "someone-elses-workspace"
    proposal = proposal_from_card(card)
    assert "tenant_id" not in proposal.model_dump()
    assert proposal.person.email == "ada@example.com"
