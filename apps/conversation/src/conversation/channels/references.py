from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from conversation.models import ConversationReference


def touch_reference(
    session: Session,
    *,
    tenant_id: uuid.UUID,
    membership_id: uuid.UUID,
    channel: str,
    external_id: str,
    reference: dict | None,
    now: datetime,
) -> None:
    row = session.scalar(
        select(ConversationReference).where(
            ConversationReference.channel == channel,
            ConversationReference.external_id == external_id,
        )
    )
    payload = reference or {}
    if row is None:
        session.add(
            ConversationReference(
                tenant_id=tenant_id,
                membership_id=membership_id,
                channel=channel,
                external_id=external_id,
                service_url=str(payload.get("serviceUrl") or ""),
                conversation_id=str(payload.get("conversationId") or ""),
                reference=payload,
                last_inbound_at=now,
            )
        )
        session.flush()
        return
    if row.tenant_id != tenant_id:
        return
    row.membership_id = membership_id
    row.last_inbound_at = now
    if payload:
        row.reference = payload
        row.service_url = str(payload.get("serviceUrl") or "")
        row.conversation_id = str(payload.get("conversationId") or "")
    session.flush()
