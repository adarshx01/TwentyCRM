from __future__ import annotations

import logging
import time
import uuid

from sqlalchemy import text

from conversation.channels.outbound import OutboundService, RoutingChannelPort
from conversation.config import Settings
from conversation.reminders.planner import ReminderService
from conversation.runtime import AppDeps, build_deps, open_services
from conversation.tenancy.lookup import claim_tenant

logger = logging.getLogger(__name__)


def execute_item(deps: AppDeps, item: dict) -> str:
    services = open_services(deps)
    try:
        status = services.worker.process_item(item)
        services.session.commit()
        return status
    except Exception:
        services.session.rollback()
        raise
    finally:
        services.session.close()


def mark_dead(deps: AppDeps, item: dict, detail: str) -> None:
    services = open_services(deps)
    try:
        services.worker.mark_failed(item, detail)
        services.session.commit()
    except Exception:
        services.session.rollback()
        logger.exception("failed to record dead letter")
    finally:
        services.session.close()


def dispatch_reminders(deps: AppDeps) -> None:
    session = deps.session_factory()
    pairs: list[tuple[uuid.UUID, uuid.UUID]] = []
    try:
        outbound = OutboundService(session, deps.settings, deps.clock, deps.http_transport)
        port = RoutingChannelPort(outbound)
        reminders = ReminderService(session, deps.clock)
        bind = session.get_bind()
        if bind is not None and bind.dialect.name == "postgresql":
            rows = session.execute(
                text("SELECT tenant_id, schedule_id FROM list_due_digests(:now)"),
                {"now": deps.clock.now()},
            ).all()
            pairs = [(row.tenant_id, row.schedule_id) for row in rows]
            session.commit()
        else:
            reminders.dispatch_due(port)
            session.commit()
    except Exception:
        session.rollback()
        logger.exception("reminder scan failed")
        return
    finally:
        session.close()
    for tenant_id, schedule_id in pairs:
        scoped = deps.session_factory()
        try:
            claim_tenant(scoped, tenant_id)
            outbound = OutboundService(scoped, deps.settings, deps.clock, deps.http_transport)
            ReminderService(scoped, deps.clock).dispatch_one(schedule_id, RoutingChannelPort(outbound))
            scoped.commit()
        except Exception:
            scoped.rollback()
            logger.exception("reminder dispatch failed")
        finally:
            scoped.close()


def run_once(deps: AppDeps) -> bool:
    queue = deps.queue
    promote = getattr(queue, "promote_due", None)
    if promote is not None:
        promote()
    item = queue.reserve(1)
    if item is None:
        dispatch_reminders(deps)
        return False
    try:
        execute_item(deps, item)
    except Exception as exc:
        updated = dict(item)
        updated["attempts"] = int(item.get("attempts", 0)) + 1
        if updated["attempts"] >= deps.settings.worker_max_attempts:
            logger.warning("queue item exhausted retries: %s", type(exc).__name__)
            mark_dead(deps, updated, str(exc))
        else:
            queue.retry(updated, min(60, 2 ** updated["attempts"]))
    dispatch_reminders(deps)
    return True


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    deps = build_deps(Settings())
    logger.info("conversation worker started")
    while True:
        worked = run_once(deps)
        if not worked:
            time.sleep(1)


if __name__ == "__main__":
    main()
