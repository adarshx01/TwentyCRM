import hashlib
import hmac
import json

from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from conversation.clock import FrozenClock
from conversation.config import Settings
from conversation.crm.client import FakeCrmClient
from conversation.db import create_schema, make_engine
from conversation.main import create_app
from conversation.runtime import build_deps
from datetime import datetime, timezone

from tests.conftest import sample_card


def _client():
    engine = make_engine("sqlite://")
    create_schema(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    clock = FrozenClock(datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc))
    crm = FakeCrmClient()
    settings = Settings(
        operator_token="operator-test-token",
        webhook_shared_secret="webhook-test-secret",
        database_url="sqlite://",
    )
    deps = build_deps(settings, session_factory=factory, clock=clock, crm_client=crm)
    return TestClient(create_app(deps)), crm, deps


def _sign(secret: str, body: bytes, stamp: str) -> str:
    digest = hmac.new(secret.encode(), f"{stamp}:{body.decode()}".encode(), hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def test_webhook_rejects_bad_signature():
    client, _crm, _deps = _client()
    response = client.post("/webhooks/whatsapp", json={"external_user_id": "1", "message_id": "m1"})
    assert response.status_code == 401


def test_webhook_ignores_tenant_in_body_and_dedupes():
    client, crm, deps = _client()
    created = client.post(
        "/admin/tenants",
        headers={"Authorization": "Bearer operator-test-token"},
        json={
            "name": "Acme",
            "deployment_id": "local",
            "twenty_workspace_id": "ws-acme",
            "twenty_base_url": "http://localhost:3000",
            "twenty_api_key_ref": "secret://tenants/acme/twenty-api-key",
        },
    )
    assert created.status_code == 200
    tenant_id = created.json()["id"]
    member = client.post(
        f"/admin/tenants/{tenant_id}/memberships",
        headers={"Authorization": "Bearer operator-test-token"},
        json={
            "display_name": "Ada",
            "role": "salesperson",
            "channel": "whatsapp",
            "external_id": "15551212",
        },
    )
    assert member.status_code == 200

    card = sample_card()
    card["tenant_id"] = "00000000-0000-0000-0000-000000000099"
    payload = {
        "external_user_id": "15551212",
        "message_id": "wamid.1",
        "text": "card",
        "tenant_id": "00000000-0000-0000-0000-000000000099",
        "card": card,
    }
    raw = json.dumps(payload).encode()
    stamp = str(int(deps.clock.now().timestamp()))
    headers = {
        "X-Conversation-Timestamp": stamp,
        "X-Conversation-Signature": _sign("webhook-test-secret", raw, stamp),
        "Content-Type": "application/json",
    }
    first = client.post("/webhooks/whatsapp", content=raw, headers=headers)
    assert first.status_code == 200
    assert first.json()["status"] == "queued"
    second = client.post("/webhooks/whatsapp", content=raw, headers=headers)
    assert second.json()["status"] == "duplicate"

    drained = client.post("/internal/queue/drain", headers={"Authorization": "Bearer operator-test-token"})
    assert drained.status_code == 200
    assert drained.json()["results"] == ["drafted"]
    assert crm.calls == []

    from conversation.models import Draft

    with deps.session_factory() as session:
        drafts = session.query(Draft).all()
    assert len(drafts) == 1
    assert str(drafts[0].tenant_id) == tenant_id
    assert "favoriteColor" not in json.dumps(drafts[0].payload)
