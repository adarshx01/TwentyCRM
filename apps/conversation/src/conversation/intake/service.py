from __future__ import annotations

import uuid
from dataclasses import dataclass

from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from conversation.crm.client import CrmClient
from conversation.crm.proposal import proposal_from_card
from conversation.drafts.service import DraftService
from conversation.errors import DomainError
from conversation.identity.service import IdentityService
from conversation.intake.parser import card_from_fields, parse_labelled_email
from conversation.models import Draft, IntakeMessage, IntakeSource, Tenant
from conversation.tenancy.lookup import find_intake_source, find_intake_source_by_id


@dataclass
class IntakeResult:
    route: str
    tenant_id: uuid.UUID | None = None
    intake_id: uuid.UUID | None = None
    draft_id: uuid.UUID | None = None
    duplicate: bool = False


class IntakeService:
    """Email intake. Does not send visitor replies (SEC-05)."""

    def __init__(
        self,
        session: Session,
        identity: IdentityService,
        drafts: DraftService,
        crm: CrmClient,
        crm_for=None,
    ) -> None:
        self.session = session
        self.identity = identity
        self.drafts = drafts
        self.crm = crm
        self.crm_for = crm_for

    def _client(self, tenant_id: uuid.UUID) -> CrmClient:
        if self.crm_for is None:
            return self.crm
        tenant = self.session.get(Tenant, tenant_id)
        if tenant is None:
            raise DomainError("not_found", "tenant not found", 404)
        return self.crm_for(tenant)

    def add_source(
        self,
        tenant_id: uuid.UUID,
        *,
        alias: str,
        mode: str,
        actor_membership_id: uuid.UUID,
    ) -> IntakeSource:
        if mode not in {"review", "auto"}:
            raise DomainError("invalid_mode", "intake mode must be review or auto")
        self.identity.get_membership(tenant_id, actor_membership_id)
        source = IntakeSource(
            tenant_id=tenant_id,
            alias=alias,
            mode=mode,
            actor_membership_id=actor_membership_id,
            status="active",
        )
        self.session.add(source)
        self.session.flush()
        return source

    def receive(self, raw: str, *, source_id: uuid.UUID | None = None) -> IntakeResult:
        parsed = parse_labelled_email(raw)
        if source_id is not None:
            source = find_intake_source_by_id(self.session, source_id)
            if source is None or source.status != "active":
                self.identity.audit(None, None, "intake.unknown_route", {"source_id": str(source_id)})
                return IntakeResult(route="unknown")
        else:
            if not parsed.alias:
                return self._unknown("missing alias")
            source = find_intake_source(self.session, parsed.alias)
            if source is None or source.status != "active":
                self.identity.audit(None, None, "intake.unknown_route", {"alias": parsed.alias})
                return IntakeResult(route="unknown")
        if not parsed.message_id:
            raise DomainError("invalid_intake", "Message-Id is required")
        existing = self.session.scalar(
            select(IntakeMessage).where(
                IntakeMessage.tenant_id == source.tenant_id,
                IntakeMessage.message_id == parsed.message_id,
            )
        )
        if existing is not None:
            return IntakeResult(
                route="duplicate",
                tenant_id=source.tenant_id,
                intake_id=existing.id,
                draft_id=existing.draft_id,
                duplicate=True,
            )
        if parsed.unknown_labels:
            message = IntakeMessage(
                tenant_id=source.tenant_id,
                source_id=source.id,
                message_id=parsed.message_id,
                status="rejected",
            )
            self.session.add(message)
            self.identity.audit(
                source.tenant_id,
                source.actor_membership_id,
                "intake.unknown_fields",
                {"labels": parsed.unknown_labels, "message_id": parsed.message_id},
            )
            return IntakeResult(
                route="rejected",
                tenant_id=source.tenant_id,
                intake_id=message.id,
            )

        proposal = None
        proposal_error = None
        try:
            proposal = proposal_from_card(card_from_fields(parsed.fields))
        except (ValidationError, ValueError) as exc:
            proposal_error = str(exc)

        message = IntakeMessage(
            tenant_id=source.tenant_id,
            source_id=source.id,
            message_id=parsed.message_id,
            status="accepted",
        )
        self.session.add(message)
        self.session.flush()

        if proposal is None:
            draft = self.drafts.open_collecting(
                source.tenant_id,
                source.actor_membership_id,
                transcript=proposal_error or "incomplete intake",
            )
            draft.state = "needs_repair"
            message.draft_id = draft.id
            message.status = "needs_repair"
            self.session.flush()
            return IntakeResult(
                route="needs_repair",
                tenant_id=source.tenant_id,
                intake_id=message.id,
                draft_id=draft.id,
            )

        try:
            draft = self.drafts.open_proposal(source.tenant_id, source.actor_membership_id, proposal)
        except DomainError as exc:
            draft = self.drafts.open_collecting(
                source.tenant_id,
                source.actor_membership_id,
                transcript=exc.code,
            )
            draft.state = "needs_repair"
            message.draft_id = draft.id
            message.status = "needs_repair"
            self.session.flush()
            return IntakeResult(
                route="needs_repair",
                tenant_id=source.tenant_id,
                intake_id=message.id,
                draft_id=draft.id,
            )
        message.draft_id = draft.id
        actor = self.identity.get_membership(source.tenant_id, source.actor_membership_id)
        if source.mode == "auto" and self.identity.can_commit(actor, actor):
            try:
                operation = self.drafts.confirm(
                    source.tenant_id,
                    draft.id,
                    actor_membership_id=actor.id,
                    version=draft.version,
                    content_hash_value=draft.content_hash,
                    client=self._client(source.tenant_id),
                )
            except DomainError:
                message.status = "needs_repair"
                self.session.flush()
                return IntakeResult(
                    route="needs_repair",
                    tenant_id=source.tenant_id,
                    intake_id=message.id,
                    draft_id=draft.id,
                )
            message.status = "committed" if operation.status == "completed" else operation.status
        else:
            message.status = "review"
        self.session.flush()
        return IntakeResult(
            route=message.status,
            tenant_id=source.tenant_id,
            intake_id=message.id,
            draft_id=draft.id,
        )

    def count_messages(self, tenant_id: uuid.UUID) -> int:
        value = self.session.scalar(
            select(func.count()).select_from(IntakeMessage).where(IntakeMessage.tenant_id == tenant_id)
        )
        return int(value or 0)

    def count_drafts(self) -> int:
        value = self.session.scalar(select(func.count()).select_from(Draft))
        return int(value or 0)

    def _unknown(self, reason: str) -> IntakeResult:
        self.identity.audit(None, None, "intake.unknown_route", {"reason": reason})
        return IntakeResult(route="unknown")
