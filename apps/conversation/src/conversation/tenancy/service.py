from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from conversation.clock import as_utc
from conversation.crm.manifest import get_manifest
from conversation.db import bind_tenant
from conversation.errors import DomainError
from conversation.models import Draft, Tenant


class TenancyService:
    def __init__(self, session: Session) -> None:
        self.session = session

    def create_tenant(
        self,
        *,
        name: str,
        deployment_id: str,
        twenty_workspace_id: str,
        twenty_base_url: str,
        twenty_api_key_ref: str,
        manifest_version: str,
        daily_draft_quota: int | None = None,
    ) -> Tenant:
        get_manifest(manifest_version)
        if not (
            twenty_api_key_ref.startswith("secret://") or twenty_api_key_ref.startswith("env://")
        ):
            raise DomainError(
                "invalid_secret_ref",
                "twenty_api_key_ref must be a secret:// or env:// reference",
            )
        tenant_id = uuid.uuid4()
        bind_tenant(self.session, tenant_id)
        tenant = Tenant(
            id=tenant_id,
            name=name,
            deployment_id=deployment_id,
            twenty_workspace_id=twenty_workspace_id,
            twenty_base_url=twenty_base_url,
            twenty_api_key_ref=twenty_api_key_ref,
            manifest_version=manifest_version,
            daily_draft_quota=daily_draft_quota,
        )
        self.session.add(tenant)
        self.session.flush()
        return tenant

    def get(self, tenant_id: uuid.UUID) -> Tenant:
        tenant = self.session.get(Tenant, tenant_id)
        if tenant is None:
            raise DomainError("not_found", "tenant not found", 404)
        return tenant

    def assert_draft_quota(self, tenant: Tenant, now: datetime) -> None:
        if tenant.daily_draft_quota is None:
            return
        start = as_utc(now).replace(hour=0, minute=0, second=0, microsecond=0)
        count = self.session.scalar(
            select(func.count())
            .select_from(Draft)
            .where(Draft.tenant_id == tenant.id, Draft.created_at >= start)
        )
        if count is not None and count >= tenant.daily_draft_quota:
            raise DomainError("quota_exceeded", "daily draft quota reached", 429)


def start_of_utc_day(now: datetime) -> datetime:
    current = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    return current.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
