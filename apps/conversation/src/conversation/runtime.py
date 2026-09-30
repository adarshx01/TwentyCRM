from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session, sessionmaker

import httpx

from conversation.channels.outbound import OutboundService
from conversation.channels.queue import MemoryQueue, RedisQueue, WorkQueue
from conversation.channels.teams_auth import BotFrameworkVerifier
from conversation.clock import Clock, SystemClock
from conversation.config import Settings
from conversation.crm.client import CrmClient, EnvSecretResolver, FakeCrmClient, HttpCrmFactory, SecretResolver
from conversation.crm.journal import Journal
from conversation.drafts.service import DraftService
from conversation.extraction.provider import Extractor, FixtureExtractor, HttpExtractor
from conversation.identity.service import IdentityService
from conversation.intake.service import IntakeService
from conversation.models import Tenant
from conversation.reminders.planner import ReminderService
from conversation.tenancy.service import TenancyService
from conversation.worker import InboundWorker


@dataclass
class AppDeps:
    settings: Settings
    session_factory: sessionmaker[Session]
    clock: Clock
    queue: WorkQueue
    crm_factory: object
    secret_resolver: SecretResolver
    teams_verifier: BotFrameworkVerifier | None = None
    http_transport: httpx.BaseTransport | None = None


@dataclass
class RequestServices:
    session: Session
    tenancy: TenancyService
    identity: IdentityService
    drafts: DraftService
    intake: IntakeService
    reminders: ReminderService
    worker: InboundWorker
    journal: Journal

    def crm_for(self, tenant: Tenant) -> CrmClient:
        return self._crm_factory.for_tenant(tenant)  # type: ignore[attr-defined]


def build_queue(settings: Settings) -> WorkQueue:
    if settings.queue_backend == "redis":
        return RedisQueue(settings.redis_url)
    return MemoryQueue()


def build_extractor(settings: Settings, transport: httpx.BaseTransport | None = None) -> Extractor:
    if settings.extraction_provider == "http":
        if not settings.extraction_http_url:
            raise RuntimeError("EXTRACTION_HTTP_URL is empty")
        return HttpExtractor(settings.extraction_http_url, transport)
    return FixtureExtractor()


def build_deps(
    settings: Settings | None = None,
    *,
    session_factory: sessionmaker[Session] | None = None,
    clock: Clock | None = None,
    queue: WorkQueue | None = None,
    crm_client: CrmClient | None = None,
    teams_verifier: BotFrameworkVerifier | None = None,
    http_transport: httpx.BaseTransport | None = None,
) -> AppDeps:
    settings = settings or Settings()
    if session_factory is None:
        from conversation.db import make_session_factory

        session_factory = make_session_factory(settings.database_url)
    resolver: SecretResolver = EnvSecretResolver()
    if crm_client is None:
        factory: object = HttpCrmFactory(resolver)
    else:
        factory = _FixedCrmFactory(crm_client)
    return AppDeps(
        settings=settings,
        session_factory=session_factory,
        clock=clock or SystemClock(),
        queue=queue or build_queue(settings),
        crm_factory=factory,
        secret_resolver=resolver,
        teams_verifier=teams_verifier if teams_verifier is not None else BotFrameworkVerifier(settings.teams_app_id),
        http_transport=http_transport,
    )


class _FixedCrmFactory:
    def __init__(self, client: CrmClient) -> None:
        self._client = client

    def for_tenant(self, tenant: Tenant) -> CrmClient:
        return self._client


def open_services(deps: AppDeps) -> RequestServices:
    session = deps.session_factory()
    identity = IdentityService(session, deps.clock)
    tenancy = TenancyService(session)
    journal = Journal(session)
    drafts = DraftService(
        session,
        deps.clock,
        identity,
        tenancy,
        journal,
        ttl_minutes=deps.settings.confirmation_ttl_minutes,
    )
    factory = deps.crm_factory
    intake = IntakeService(
        session,
        identity,
        drafts,
        FakeCrmClient(),
        crm_for=factory.for_tenant,  # type: ignore[attr-defined]
    )
    reminders = ReminderService(session, deps.clock)
    outbound = OutboundService(session, deps.settings, deps.clock, deps.http_transport)
    worker = InboundWorker(
        session,
        identity,
        drafts,
        build_extractor(deps.settings, deps.http_transport),
        deps.queue,
        clock=deps.clock,
        outbound=outbound,
        crm_for=factory.for_tenant,  # type: ignore[attr-defined]
    )
    services = RequestServices(
        session=session,
        tenancy=tenancy,
        identity=identity,
        drafts=drafts,
        intake=intake,
        reminders=reminders,
        worker=worker,
        journal=journal,
    )
    services._crm_factory = factory  # type: ignore[attr-defined]
    return services


