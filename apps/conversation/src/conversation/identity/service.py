from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from conversation.clock import Clock, as_utc
from conversation.errors import DomainError
from conversation.models import AuditEvent, ChannelBinding, EnrollmentCode, Membership
from conversation.tenancy.lookup import find_channel_binding, find_enrollment_code

ROLES = frozenset({"salesperson", "manager", "cxo", "client_admin"})
COMMIT_OWNER_ROLES = frozenset({"salesperson", "manager"})


def hash_code(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


class IdentityService:
    def __init__(self, session: Session, clock: Clock) -> None:
        self.session = session
        self.clock = clock

    def add_membership(
        self,
        tenant_id: uuid.UUID,
        *,
        display_name: str,
        role: str,
        channel: str | None = None,
        external_id: str | None = None,
    ) -> Membership:
        if role not in ROLES:
            raise DomainError("invalid_role", f"unknown role {role}")
        membership = Membership(tenant_id=tenant_id, display_name=display_name, role=role, status="active")
        self.session.add(membership)
        self.session.flush()
        if channel and external_id:
            self.bind_channel(tenant_id, membership.id, channel=channel, external_id=external_id)
        return membership

    def bind_channel(
        self,
        tenant_id: uuid.UUID,
        membership_id: uuid.UUID,
        *,
        channel: str,
        external_id: str,
    ) -> ChannelBinding:
        self.get_membership(tenant_id, membership_id)
        existing = self.session.scalar(
            select(ChannelBinding).where(
                ChannelBinding.channel == channel,
                ChannelBinding.external_id == external_id,
            )
        )
        if existing is not None:
            raise DomainError("binding_exists", "channel identity already bound")
        binding = ChannelBinding(
            tenant_id=tenant_id,
            membership_id=membership_id,
            channel=channel,
            external_id=external_id,
            status="active",
        )
        self.session.add(binding)
        self.session.flush()
        return binding

    def get_membership(self, tenant_id: uuid.UUID, membership_id: uuid.UUID) -> Membership:
        membership = self.session.scalar(
            select(Membership).where(
                Membership.id == membership_id,
                Membership.tenant_id == tenant_id,
            )
        )
        if membership is None:
            raise DomainError("not_found", "membership not found", 404)
        return membership

    def find_binding(self, channel: str, external_id: str) -> ChannelBinding | None:
        """Binding for a channel identity. Does not trust a tenant id from the message."""
        return find_channel_binding(self.session, channel, external_id)

    def resolve_binding(self, channel: str, external_id: str) -> ChannelBinding | None:
        binding = self.find_binding(channel, external_id)
        if binding is None or binding.status != "active":
            return None
        return binding

    def issue_enrollment_code(
        self,
        tenant_id: uuid.UUID,
        *,
        role: str,
        ttl: timedelta = timedelta(hours=24),
    ) -> str:
        if role not in ROLES:
            raise DomainError("invalid_role", f"unknown role {role}")
        plaintext = secrets.token_urlsafe(18)
        row = EnrollmentCode(
            tenant_id=tenant_id,
            code_hash=hash_code(plaintext),
            role=role,
            expires_at=self.clock.now() + ttl,
        )
        self.session.add(row)
        self.session.flush()
        return plaintext

    def redeem_enrollment_code(
        self,
        *,
        code: str,
        display_name: str,
        channel: str,
        external_id: str,
    ) -> Membership:
        row = find_enrollment_code(self.session, hash_code(code))
        if row is None or row.consumed_at is not None:
            raise DomainError("invalid_code", "enrollment code is not valid", 400)
        if as_utc(row.expires_at) < self.clock.now():
            raise DomainError("invalid_code", "enrollment code expired", 400)
        membership = self.add_membership(
            row.tenant_id,
            display_name=display_name,
            role=row.role,
            channel=channel,
            external_id=external_id,
        )
        row.consumed_at = self.clock.now()
        row.membership_id = membership.id
        self.session.flush()
        return membership

    def revoke(self, tenant_id: uuid.UUID, membership_id: uuid.UUID, actor_membership_id: uuid.UUID) -> Membership:
        actor = self.get_membership(tenant_id, actor_membership_id)
        if actor.status != "active" or actor.role != "client_admin":
            raise DomainError("forbidden", "only an active client admin can revoke", 403)
        target = self.get_membership(tenant_id, membership_id)
        target.status = "revoked"
        bindings = self.session.scalars(
            select(ChannelBinding).where(
                ChannelBinding.tenant_id == tenant_id,
                ChannelBinding.membership_id == membership_id,
            )
        ).all()
        for binding in bindings:
            binding.status = "revoked"
        self.audit(tenant_id, actor.id, "membership.revoked", {"membership_id": str(membership_id)})
        self.session.flush()
        return target

    def can_commit(self, actor: Membership, owner: Membership) -> bool:
        if actor.status != "active" or actor.tenant_id != owner.tenant_id:
            return False
        if actor.role == "salesperson":
            return actor.id == owner.id
        if actor.role == "manager":
            return owner.role in COMMIT_OWNER_ROLES
        return False

    def audit(
        self,
        tenant_id: uuid.UUID | None,
        actor_membership_id: uuid.UUID | None,
        action: str,
        detail: dict,
    ) -> None:
        self.session.add(
            AuditEvent(
                tenant_id=tenant_id,
                actor_membership_id=actor_membership_id,
                action=action,
                detail=detail,
            )
        )
        self.session.flush()
