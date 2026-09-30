from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class PersonProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    email: str
    phone: str | None = None
    job_title: str | None = None


class CompanyProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    domain_name: str


class OpportunityProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    stage: str
    amount: float | None = None
    source: str | None = None
    solution_interest: str | None = None


class NoteProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    body: str


class TaskProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    due_at: datetime | None = None
    body: str | None = None


class ActionProposal(BaseModel):
    """Typed CRM action. Unknown keys are rejected (AT-07)."""

    model_config = ConfigDict(extra="forbid")

    person: PersonProposal
    company: CompanyProposal | None = None
    opportunity: OpportunityProposal
    note: NoteProposal | None = None
    task: TaskProposal | None = None


UNTRUSTED_ROUTING_KEYS = frozenset({"tenant_id", "deployment_id", "twenty_workspace_id"})


def proposal_from_card(card: dict) -> ActionProposal:
    cleaned = {key: value for key, value in card.items() if key not in UNTRUSTED_ROUTING_KEYS}
    return ActionProposal.model_validate(cleaned)


def canonical_payload(proposal: ActionProposal) -> dict:
    return proposal.model_dump(mode="json")
