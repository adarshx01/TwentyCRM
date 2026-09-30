from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import JSON


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Tenant(Base):
    __tablename__ = "tenants"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200))
    deployment_id: Mapped[str] = mapped_column(String(200))
    twenty_workspace_id: Mapped[str] = mapped_column(String(200))
    twenty_base_url: Mapped[str] = mapped_column(String(500))
    twenty_api_key_ref: Mapped[str] = mapped_column(String(500))
    manifest_version: Mapped[str] = mapped_column(String(40))
    daily_draft_quota: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(40), default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Membership(Base):
    __tablename__ = "memberships"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("tenants.id"), index=True)
    display_name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(40), default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ChannelBinding(Base):
    __tablename__ = "channel_bindings"
    __table_args__ = (UniqueConstraint("channel", "external_id", name="uq_channel_external"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("tenants.id"), index=True)
    membership_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("memberships.id"))
    channel: Mapped[str] = mapped_column(String(40))
    external_id: Mapped[str] = mapped_column(String(300))
    status: Mapped[str] = mapped_column(String(40), default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class EnrollmentCode(Base):
    __tablename__ = "enrollment_codes"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("tenants.id"), index=True)
    code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    role: Mapped[str] = mapped_column(String(40))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    membership_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Draft(Base):
    __tablename__ = "drafts"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("tenants.id"), index=True)
    membership_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("memberships.id"))
    state: Mapped[str] = mapped_column(String(40))
    version: Mapped[int] = mapped_column(Integer, default=1)
    content_hash: Mapped[str] = mapped_column(String(64))
    manifest_version: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict] = mapped_column(JSON)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Operation(Base):
    __tablename__ = "operations"
    __table_args__ = (UniqueConstraint("idempotency_key", name="uq_operation_idempotency"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("tenants.id"), index=True)
    draft_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("drafts.id"))
    actor_membership_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True))
    idempotency_key: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(40), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OperationStep(Base):
    __tablename__ = "operation_steps"
    __table_args__ = (UniqueConstraint("operation_id", "step_key", name="uq_operation_step"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), index=True)
    operation_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("operations.id"))
    step_key: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(40), default="pending")
    external_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class Outbox(Base):
    __tablename__ = "outbox"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(40), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Schedule(Base):
    __tablename__ = "schedules"
    __table_args__ = (
        UniqueConstraint("tenant_id", "membership_id", "kind", "period_key", name="uq_schedule_period"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), index=True)
    membership_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True))
    kind: Mapped[str] = mapped_column(String(40))
    period_key: Mapped[str] = mapped_column(String(40))
    next_run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(40), default="pending")


class IntakeSource(Base):
    __tablename__ = "intake_sources"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("tenants.id"), index=True)
    alias: Mapped[str] = mapped_column(String(200), unique=True)
    mode: Mapped[str] = mapped_column(String(40))
    actor_membership_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True))
    status: Mapped[str] = mapped_column(String(40), default="active")


class IntakeMessage(Base):
    __tablename__ = "intake_messages"
    __table_args__ = (UniqueConstraint("tenant_id", "message_id", name="uq_intake_message"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), index=True)
    source_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("intake_sources.id"))
    message_id: Mapped[str] = mapped_column(String(500))
    draft_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    status: Mapped[str] = mapped_column(String(40))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ConversationReference(Base):
    """Proactive-send address captured from an allowlisted employee chat.

    WhatsApp rows track the last inbound time for the 24-hour session window.
    Teams rows store the Bot Connector conversation reference. Neither row is a
    customer destination.
    """

    __tablename__ = "conversation_references"
    __table_args__ = (UniqueConstraint("channel", "external_id", name="uq_conversation_reference"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("tenants.id"), index=True)
    membership_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("memberships.id"))
    channel: Mapped[str] = mapped_column(String(40))
    external_id: Mapped[str] = mapped_column(String(300))
    service_url: Mapped[str] = mapped_column(String(500), default="")
    conversation_id: Mapped[str] = mapped_column(String(500), default="")
    reference: Mapped[dict] = mapped_column(JSON)
    last_inbound_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class InboundEvent(Base):
    __tablename__ = "inbound_events"
    __table_args__ = (UniqueConstraint("channel", "external_message_id", name="uq_inbound_message"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True, index=True)
    channel: Mapped[str] = mapped_column(String(40))
    external_message_id: Mapped[str] = mapped_column(String(300))
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(40), default="queued")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True, index=True)
    actor_membership_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    action: Mapped[str] = mapped_column(String(80))
    detail: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
