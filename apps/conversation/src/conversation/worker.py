from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from conversation.channels.events import NormalizedInboundEvent
from conversation.channels.outbound import OutboundService
from conversation.channels.queue import WorkQueue
from conversation.channels.references import touch_reference
from conversation.clock import Clock, SystemClock
from conversation.drafts.service import DraftService
from conversation.errors import DomainError
from conversation.extraction.provider import Extractor
from conversation.identity.service import IdentityService
from conversation.models import InboundEvent, Outbox, Tenant
from conversation.tenancy.lookup import claim_tenant


class InboundWorker:
    """Resolve tenant from the channel binding, never from the message body."""

    def __init__(
        self,
        session: Session,
        identity: IdentityService,
        drafts: DraftService,
        extractor: Extractor,
        queue: WorkQueue,
        clock: Clock | None = None,
        outbound: OutboundService | None = None,
        crm_for=None,
    ) -> None:
        self.session = session
        self.identity = identity
        self.drafts = drafts
        self.extractor = extractor
        self.queue = queue
        self.clock = clock or SystemClock()
        self.outbound = outbound
        self.crm_for = crm_for

    def accept(self, event: NormalizedInboundEvent) -> str:
        binding = self.identity.find_binding(event.channel, event.external_user_id)
        if binding is None:
            self.identity.audit(
                None,
                None,
                "inbound.unresolved",
                {"channel": event.channel, "message_id": event.message_id},
            )
            return "unresolved"
        existing = self.session.scalar(
            select(InboundEvent).where(
                InboundEvent.tenant_id == binding.tenant_id,
                InboundEvent.channel == event.channel,
                InboundEvent.external_message_id == event.message_id,
            )
        )
        if existing is not None:
            return "duplicate"
        membership = self.identity.get_membership(binding.tenant_id, binding.membership_id)
        row = InboundEvent(
            tenant_id=binding.tenant_id,
            channel=event.channel,
            external_message_id=event.message_id,
            payload={
                "provider_event_id": event.message_id,
                "external_user_id": event.external_user_id,
                "text": event.text,
                "card": event.card,
                "conversation_reference": event.conversation_reference,
            },
            status="queued",
        )
        self.session.add(row)
        try:
            self.session.flush()
        except IntegrityError:
            self.session.rollback()
            return "duplicate"
        if membership.status != "active" or binding.status != "active":
            row.status = "revoked"
            self.session.flush()
            return "revoked"
        touch_reference(
            self.session,
            tenant_id=binding.tenant_id,
            membership_id=binding.membership_id,
            channel=event.channel,
            external_id=event.external_user_id,
            reference=event.conversation_reference,
            now=self.clock.now(),
        )
        self.queue.enqueue(
            {
                "inbound_id": str(row.id),
                "tenant_id": str(binding.tenant_id),
                "channel": event.channel,
                "message_id": event.message_id,
                "attempts": 0,
            }
        )
        return "queued"

    def drain(self) -> list[str]:
        results: list[str] = []
        for item in self.queue.drain():
            results.append(self.process_item(item))
        return results

    def process_item(self, item: dict) -> str:
        tenant_raw = item.get("tenant_id")
        if tenant_raw:
            claim_tenant(self.session, uuid.UUID(str(tenant_raw)))
        try:
            return self._process_message(str(item.get("channel") or ""), str(item.get("message_id") or ""))
        except DomainError:
            self._mark_status(item, "rejected")
            return "rejected"

    def mark_failed(self, item: dict, detail: str) -> None:
        self._mark_status(item, "failed", detail)

    def _mark_status(self, item: dict, status: str, detail: str | None = None) -> None:
        tenant_raw = item.get("tenant_id")
        if tenant_raw:
            claim_tenant(self.session, uuid.UUID(str(tenant_raw)))
        row = self.session.scalar(
            select(InboundEvent).where(
                InboundEvent.channel == item.get("channel"),
                InboundEvent.external_message_id == item.get("message_id"),
            )
        )
        if row is None:
            return
        row.status = status
        if detail:
            payload = dict(row.payload or {})
            payload["last_error"] = detail[:500]
            row.payload = payload
        self.session.flush()

    def _process_message(self, channel: str, message_id: str) -> str:
        row = self.session.scalar(
            select(InboundEvent).where(
                InboundEvent.channel == channel,
                InboundEvent.external_message_id == message_id,
            )
        )
        if row is None or row.tenant_id is None:
            return "missing"
        payload = row.payload or {}
        external_user_id = str(payload.get("external_user_id", ""))
        binding = self.identity.resolve_binding(channel, external_user_id)
        if binding is None or binding.tenant_id != row.tenant_id:
            row.status = "unresolved"
            self.session.flush()
            return "unresolved"
        membership = self.identity.get_membership(binding.tenant_id, binding.membership_id)
        if membership.status != "active":
            row.status = "revoked"
            self.session.flush()
            return "revoked"
        card = payload.get("card")
        reference = payload.get("conversation_reference")
        event = NormalizedInboundEvent(
            channel=channel,
            external_user_id=external_user_id,
            message_id=message_id,
            text=payload.get("text"),
            card=card if isinstance(card, dict) else None,
            conversation_reference=reference if isinstance(reference, dict) else None,
        )
        control = self._control(binding.tenant_id, membership.id, event)
        if control is not None:
            row.status = control
            self.session.flush()
            return control
        try:
            proposal = self.extractor.extract(event)
        except DomainError:
            row.status = "rejected"
            self.identity.audit(
                binding.tenant_id,
                membership.id,
                "inbound.rejected",
                {"message_id": message_id},
            )
            self.session.flush()
            return "rejected"
        if proposal is None:
            self.drafts.open_collecting(binding.tenant_id, membership.id, event.text or "")
            row.status = "collecting"
        else:
            draft = self.drafts.open_proposal(binding.tenant_id, membership.id, proposal)
            row.status = "drafted"
            self.identity.audit(
                binding.tenant_id,
                membership.id,
                "inbound.drafted",
                {"draft_id": str(draft.id), "message_id": message_id},
            )
            self._notify_preview(binding.tenant_id, membership.id, draft)
        self.session.flush()
        return row.status

    def _control(self, tenant_id: uuid.UUID, membership_id: uuid.UUID, event: NormalizedInboundEvent) -> str | None:
        card = event.card or {}
        action = card.get("action")
        if action not in {"confirm", "cancel", "edit"}:
            return None
        try:
            draft_id = uuid.UUID(str(card.get("draft_id")))
        except (TypeError, ValueError) as exc:
            raise DomainError("invalid_body", "draft_id is required") from exc
        if action == "cancel":
            self.drafts.cancel(tenant_id, draft_id, actor_membership_id=membership_id)
            return "cancelled"
        if action == "edit":
            proposal_card = card.get("proposal")
            if not isinstance(proposal_card, dict):
                raise DomainError("invalid_proposal", "edit requires a proposal object")
            self.drafts.edit(tenant_id, draft_id, actor_membership_id=membership_id, card=proposal_card)
            return "edited"
        try:
            version = int(card["version"])
            content_hash_value = str(card["content_hash"])
        except (TypeError, ValueError, KeyError) as exc:
            raise DomainError("invalid_body", "confirm card is incomplete") from exc
        if self.crm_for is None:
            raise DomainError("not_ready", "crm client is not configured", 409)
        tenant = self.session.get(Tenant, tenant_id)
        if tenant is None:
            raise DomainError("not_found", "tenant not found", 404)
        self.drafts.confirm(
            tenant_id,
            draft_id,
            actor_membership_id=membership_id,
            version=version,
            content_hash_value=content_hash_value,
            client=self.crm_for(tenant),
        )
        return "committed"

    def _notify_preview(self, tenant_id: uuid.UUID, membership_id: uuid.UUID, draft) -> None:
        if self.outbound is None:
            return
        text = (
            f"Preview {draft.id}\n"
            f"version {draft.version}\n"
            f"content_hash {draft.content_hash}\n"
            "Confirm, edit, or cancel with the signed draft API. "
            "A chat card may send action=confirm with this version and content_hash."
        )
        result = self.outbound.send_to_membership(tenant_id, membership_id, text, kind="preview")
        self.session.add(
            Outbox(
                tenant_id=tenant_id,
                kind="preview",
                payload={
                    "draft_id": str(draft.id),
                    "status": result.status,
                    "error_code": result.error_code,
                    "detail": result.detail,
                },
                status=result.status,
            )
        )
