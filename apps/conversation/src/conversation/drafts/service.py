from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from conversation.clock import Clock, as_utc
from conversation.crm.client import CrmClient
from conversation.crm.journal import Journal, idempotency_key
from conversation.crm.manifest import assert_stage, get_manifest
from conversation.crm.proposal import ActionProposal, canonical_payload, proposal_from_card
from conversation.drafts.hashing import content_hash
from conversation.errors import DomainError
from conversation.identity.service import IdentityService
from conversation.models import Draft, Operation
from conversation.tenancy.service import TenancyService

CONFIRMABLE = frozenset({"awaiting_confirmation", "needs_repair", "committing"})


class DraftService:
    def __init__(
        self,
        session: Session,
        clock: Clock,
        identity: IdentityService,
        tenancy: TenancyService,
        journal: Journal,
        *,
        ttl_minutes: int = 30,
    ) -> None:
        self.session = session
        self.clock = clock
        self.identity = identity
        self.tenancy = tenancy
        self.journal = journal
        self.ttl = timedelta(minutes=ttl_minutes)

    def list_drafts(self, tenant_id: uuid.UUID) -> list[Draft]:
        return list(
            self.session.scalars(select(Draft).where(Draft.tenant_id == tenant_id).order_by(Draft.created_at)).all()
        )

    def get(self, tenant_id: uuid.UUID, draft_id: uuid.UUID) -> Draft:
        draft = self.session.scalar(select(Draft).where(Draft.id == draft_id, Draft.tenant_id == tenant_id))
        if draft is None:
            raise DomainError("not_found", "draft not found", 404)
        return draft

    def open_proposal(
        self,
        tenant_id: uuid.UUID,
        membership_id: uuid.UUID,
        proposal: ActionProposal,
    ) -> Draft:
        tenant = self.tenancy.get(tenant_id)
        self.tenancy.assert_draft_quota(tenant, self.clock.now())
        owner = self.identity.get_membership(tenant_id, membership_id)
        if owner.status != "active":
            raise DomainError("revoked", "membership is revoked", 403)
        manifest = get_manifest(tenant.manifest_version)
        assert_stage(manifest, proposal.opportunity.stage)
        payload = canonical_payload(proposal)
        now = self.clock.now()
        draft = Draft(
            tenant_id=tenant_id,
            membership_id=owner.id,
            state="awaiting_confirmation",
            version=1,
            content_hash=content_hash(payload),
            manifest_version=manifest.version,
            payload=payload,
            expires_at=now + self.ttl,
            created_at=now,
            updated_at=now,
        )
        self.session.add(draft)
        self.session.flush()
        self.identity.audit(tenant_id, owner.id, "draft.opened", {"draft_id": str(draft.id)})
        return draft

    def open_collecting(self, tenant_id: uuid.UUID, membership_id: uuid.UUID, transcript: str) -> Draft:
        tenant = self.tenancy.get(tenant_id)
        self.tenancy.assert_draft_quota(tenant, self.clock.now())
        owner = self.identity.get_membership(tenant_id, membership_id)
        payload = {"transcript": transcript}
        now = self.clock.now()
        draft = Draft(
            tenant_id=tenant_id,
            membership_id=owner.id,
            state="collecting",
            version=1,
            content_hash=content_hash(payload),
            manifest_version=tenant.manifest_version,
            payload=payload,
            expires_at=None,
            created_at=now,
            updated_at=now,
        )
        self.session.add(draft)
        self.session.flush()
        return draft

    def confirm(
        self,
        tenant_id: uuid.UUID,
        draft_id: uuid.UUID,
        *,
        actor_membership_id: uuid.UUID,
        version: int,
        content_hash_value: str,
        client: CrmClient,
    ) -> Operation:
        draft = self.get(tenant_id, draft_id)
        actor = self.identity.get_membership(tenant_id, actor_membership_id)
        owner = self.identity.get_membership(tenant_id, draft.membership_id)
        if not self.identity.can_commit(actor, owner):
            raise DomainError("forbidden", "actor cannot commit this draft", 403)
        self._expire_if_needed(draft)
        if draft.state == "expired":
            raise DomainError("expired", "draft confirmation window elapsed", 409)
        if draft.state == "cancelled":
            raise DomainError("cancelled", "draft was cancelled", 409)
        if draft.version != version or draft.content_hash != content_hash_value:
            raise DomainError("conflict", "version or content hash does not match the preview", 409)

        key = idempotency_key(draft.id, draft.version, draft.content_hash)
        existing = self.session.scalar(
            select(Operation).where(Operation.tenant_id == tenant_id, Operation.idempotency_key == key)
        )
        if draft.state == "committed":
            if existing is None:
                raise DomainError("conflict", "committed draft has no journal", 409)
            self.identity.audit(
                tenant_id,
                actor.id,
                "draft.confirm_replay",
                {"draft_id": str(draft.id), "operation_id": str(existing.id)},
            )
            return existing

        if draft.state not in CONFIRMABLE:
            raise DomainError("not_ready", f"draft is {draft.state}", 409)

        proposal = self._parse_proposal(draft)
        manifest = get_manifest(draft.manifest_version)
        assert_stage(manifest, proposal.opportunity.stage)

        draft.state = "committing"
        draft.updated_at = self.clock.now()
        operation = existing or Operation(
            tenant_id=tenant_id,
            draft_id=draft.id,
            actor_membership_id=actor.id,
            idempotency_key=key,
            status="running",
        )
        if existing is None:
            self.session.add(operation)
        else:
            operation.status = "running"
            operation.actor_membership_id = actor.id
        self.session.flush()
        try:
            self.journal.execute(operation, proposal, client)
        except DomainError:
            draft.state = "needs_repair"
            draft.updated_at = self.clock.now()
            self.session.flush()
            raise
        draft.state = "committed"
        draft.updated_at = self.clock.now()
        self.identity.audit(
            tenant_id,
            actor.id,
            "draft.committed",
            {"draft_id": str(draft.id), "operation_id": str(operation.id)},
        )
        self.session.flush()
        return operation

    def edit(
        self,
        tenant_id: uuid.UUID,
        draft_id: uuid.UUID,
        *,
        actor_membership_id: uuid.UUID,
        card: dict,
    ) -> Draft:
        draft = self.get(tenant_id, draft_id)
        actor = self.identity.get_membership(tenant_id, actor_membership_id)
        owner = self.identity.get_membership(tenant_id, draft.membership_id)
        if not self.identity.can_commit(actor, owner):
            raise DomainError("forbidden", "actor cannot edit this draft", 403)
        self._expire_if_needed(draft)
        if draft.state not in {"awaiting_confirmation", "collecting", "needs_repair"}:
            raise DomainError("conflict", f"cannot edit a draft in {draft.state}", 409)
        try:
            proposal = proposal_from_card(card)
        except Exception as exc:
            raise DomainError("invalid_proposal", "edit contains fields that are not in the manifest") from exc
        tenant = self.tenancy.get(tenant_id)
        manifest = get_manifest(tenant.manifest_version)
        assert_stage(manifest, proposal.opportunity.stage)
        payload = canonical_payload(proposal)
        now = self.clock.now()
        draft.payload = payload
        draft.version = draft.version + 1
        draft.content_hash = content_hash(payload)
        draft.state = "awaiting_confirmation"
        draft.manifest_version = manifest.version
        draft.expires_at = now + self.ttl
        draft.updated_at = now
        self.identity.audit(tenant_id, actor.id, "draft.edited", {"draft_id": str(draft.id), "version": draft.version})
        self.session.flush()
        return draft

    def cancel(
        self,
        tenant_id: uuid.UUID,
        draft_id: uuid.UUID,
        *,
        actor_membership_id: uuid.UUID,
    ) -> Draft:
        draft = self.get(tenant_id, draft_id)
        actor = self.identity.get_membership(tenant_id, actor_membership_id)
        owner = self.identity.get_membership(tenant_id, draft.membership_id)
        if not self.identity.can_commit(actor, owner):
            raise DomainError("forbidden", "actor cannot cancel this draft", 403)
        self._expire_if_needed(draft)
        if draft.state not in {"awaiting_confirmation", "collecting", "needs_repair"}:
            raise DomainError("conflict", f"cannot cancel a draft in {draft.state}", 409)
        draft.state = "cancelled"
        draft.updated_at = self.clock.now()
        self.identity.audit(tenant_id, actor.id, "draft.cancelled", {"draft_id": str(draft.id)})
        self.session.flush()
        return draft

    def _expire_if_needed(self, draft: Draft) -> None:
        if draft.expires_at is None:
            return
        if draft.state in {"committed", "cancelled", "expired"}:
            return
        if as_utc(draft.expires_at) <= self.clock.now():
            draft.state = "expired"
            draft.updated_at = self.clock.now()
            self.session.flush()

    def _parse_proposal(self, draft: Draft) -> ActionProposal:
        try:
            return ActionProposal.model_validate(draft.payload)
        except Exception as exc:
            raise DomainError("not_ready", "draft payload is not a valid action proposal", 409) from exc
