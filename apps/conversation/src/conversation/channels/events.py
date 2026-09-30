from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass(frozen=True)
class NormalizedInboundEvent:
    channel: str
    external_user_id: str
    message_id: str
    text: str | None = None
    card: dict | None = None
    received_at: datetime | None = None
    # Present only so tests can prove it is ignored (TEN-01).
    claimed_tenant_id: str | None = field(default=None)
    conversation_reference: dict | None = None
