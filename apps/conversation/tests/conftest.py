from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

import pytest
from sqlalchemy.orm import Session, sessionmaker

from conversation.clock import FrozenClock
from conversation.crm.client import FakeCrmClient
from conversation.crm.journal import Journal
from conversation.crm.proposal import ActionProposal
from conversation.db import create_schema, make_engine
from conversation.drafts.service import DraftService
from conversation.identity.service import IdentityService
from conversation.intake.service import IntakeService
from conversation.models import Membership, Tenant
from conversation.reminders.planner import ReminderService
from conversation.tenancy.service import TenancyService


@dataclass
class World:
    session: Session
    clock: FrozenClock
    crm: FakeCrmClient
    tenancy: TenancyService
    identity: IdentityService
    drafts: DraftService
    intake: IntakeService
    reminders: ReminderService
    journal: Journal


@pytest.fixture
def clock() -> FrozenClock:
    return FrozenClock(datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc))


@pytest.fixture
def world(clock: FrozenClock) -> World:
    engine = make_engine("sqlite://")
    create_schema(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    session = factory()
    identity = IdentityService(session, clock)
    tenancy = TenancyService(session)
    journal = Journal(session)
    drafts = DraftService(session, clock, identity, tenancy, journal)
    crm = FakeCrmClient()
    intake = IntakeService(session, identity, drafts, crm)
    reminders = ReminderService(session, clock)
    return World(session, clock, crm, tenancy, identity, drafts, intake, reminders, journal)


def sample_card(email: str = "ada@example.com", stage: str = "NEW", **extra: object) -> dict:
    card: dict = {
        "person": {"name": "Ada Lovelace", "email": email, "job_title": "Buyer"},
        "company": {"name": "Analytical Engines", "domain_name": "engines.example"},
        "opportunity": {"name": "Analytical Engines — Voice", "stage": stage, "source": "EVENT"},
        "note": {"title": "Card", "body": "Met at the booth"},
        "task": {"title": "Follow up", "due_at": "2026-10-02T09:00:00Z"},
    }
    card.update(extra)
    return card


def proposal(email: str = "ada@example.com", stage: str = "NEW") -> ActionProposal:
    return ActionProposal.model_validate(sample_card(email=email, stage=stage))


def open_tenant(world: World, name: str, external_id: str) -> tuple[Tenant, Membership, Membership]:
    tenant = world.tenancy.create_tenant(
        name=name,
        deployment_id="local",
        twenty_workspace_id=f"ws-{name}",
        twenty_base_url="http://localhost:3000",
        twenty_api_key_ref=f"secret://tenants/{name}/twenty-api-key",
        manifest_version="2026.1",
    )
    admin = world.identity.add_membership(tenant.id, display_name=f"{name} admin", role="client_admin")
    sales = world.identity.add_membership(
        tenant.id,
        display_name=f"{name} sales",
        role="salesperson",
        channel="whatsapp",
        external_id=external_id,
    )
    return tenant, admin, sales


def new_id() -> uuid.UUID:
    return uuid.uuid4()
