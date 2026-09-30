from __future__ import annotations

from urllib.parse import urlparse

import httpx
from sqlalchemy import text

from conversation.runtime import AppDeps


def build_health(deps: AppDeps) -> tuple[int, dict]:
    database = _database(deps)
    redis_state = _redis(deps)
    twenty = _twenty(deps.settings.twenty_base_url)
    whatsapp = bool(
        deps.settings.whatsapp_verify_token
        and deps.settings.whatsapp_app_secret
        and deps.settings.whatsapp_access_token
        and deps.settings.whatsapp_phone_number_id
    )
    teams = bool(deps.settings.teams_app_id and deps.settings.teams_app_password)
    report = {
        "status": "ok" if database == "ok" else "degraded",
        "service": "conversation",
        "wiring": {
            "database": database,
            "redis": redis_state,
            "queue_backend": deps.settings.queue_backend,
            "twenty": twenty,
            "whatsapp_configured": whatsapp,
            "teams_configured": teams,
            "teams_shared_secret_configured": _real(deps.settings.teams_shared_secret)
            or _real(deps.settings.webhook_shared_secret),
            "extraction_provider": deps.settings.extraction_provider,
        },
    }
    return (200 if database == "ok" else 503), report


def _real(value: str) -> bool:
    return bool(value) and value != "replace-me"


def _database(deps: AppDeps) -> str:
    session = deps.session_factory()
    try:
        session.execute(text("SELECT 1"))
        return "ok"
    except Exception:
        return "error"
    finally:
        session.close()


def _redis(deps: AppDeps) -> str:
    if deps.settings.queue_backend != "redis":
        return "memory"
    try:
        import redis

        client = redis.Redis.from_url(deps.settings.redis_url, socket_connect_timeout=1)
        client.ping()
        return "ok"
    except Exception:
        return "error"


def _twenty(base_url: str) -> str:
    host = urlparse(base_url).hostname or ""
    if not host:
        return "unreachable"
    try:
        response = httpx.get(base_url.rstrip("/") + "/healthz", timeout=1.5, trust_env=False)
    except Exception:
        return "unreachable"
    if response.status_code < 500:
        return "reachable"
    return "unreachable"
