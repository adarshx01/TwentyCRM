from __future__ import annotations

import uuid

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from conversation.db import bind_tenant
from conversation.models import ChannelBinding, EnrollmentCode, IntakeSource


def _postgres(session: Session) -> bool:
    bind = session.get_bind()
    return bind is not None and bind.dialect.name == "postgresql"


def find_channel_binding(session: Session, channel: str, external_id: str) -> ChannelBinding | None:
    if _postgres(session):
        row = session.execute(
            text(
                "SELECT tenant_id, binding_id FROM resolve_channel_binding(:channel, :external_id)"
            ),
            {"channel": channel, "external_id": external_id},
        ).mappings().first()
        if row is None:
            return None
        bind_tenant(session, row["tenant_id"])
        return session.get(ChannelBinding, row["binding_id"])
    return session.scalar(
        select(ChannelBinding).where(
            ChannelBinding.channel == channel,
            ChannelBinding.external_id == external_id,
        )
    )


def find_intake_source(session: Session, alias: str) -> IntakeSource | None:
    if _postgres(session):
        row = session.execute(
            text("SELECT tenant_id, source_id FROM resolve_intake_alias(:alias)"),
            {"alias": alias},
        ).mappings().first()
        if row is None:
            return None
        bind_tenant(session, row["tenant_id"])
        return session.get(IntakeSource, row["source_id"])
    return session.scalar(select(IntakeSource).where(IntakeSource.alias == alias, IntakeSource.status == "active"))


def find_intake_source_by_id(session: Session, source_id: uuid.UUID) -> IntakeSource | None:
    if _postgres(session):
        row = session.execute(
            text("SELECT tenant_id, source_id FROM resolve_intake_source(:source_id)"),
            {"source_id": source_id},
        ).mappings().first()
        if row is None:
            return None
        bind_tenant(session, row["tenant_id"])
        return session.get(IntakeSource, row["source_id"])
    return session.get(IntakeSource, source_id)


def find_enrollment_code(session: Session, code_hash: str) -> EnrollmentCode | None:
    if _postgres(session):
        row = session.execute(
            text("SELECT tenant_id, code_id FROM resolve_enrollment_code(:code_hash)"),
            {"code_hash": code_hash},
        ).mappings().first()
        if row is None:
            return None
        bind_tenant(session, row["tenant_id"])
        return session.get(EnrollmentCode, row["code_id"])
    return session.scalar(select(EnrollmentCode).where(EnrollmentCode.code_hash == code_hash))


def claim_tenant(session: Session, tenant_id: uuid.UUID) -> None:
    """Bind RLS to a tenant id the application already decided, never one from a model."""
    bind_tenant(session, tenant_id)
