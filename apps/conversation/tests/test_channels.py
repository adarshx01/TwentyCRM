import hashlib
import hmac
import json
import time
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import jwt
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm
from sqlalchemy.orm import sessionmaker

from conversation.channels.outbound import OutboundService
from conversation.channels.teams_auth import CONNECTOR_ISSUER
from conversation.clock import FrozenClock
from conversation.config import Settings
from conversation.crm.client import FakeCrmClient
from conversation.db import create_schema, make_engine
from conversation.main import create_app
from conversation.models import ConversationReference
from conversation.runtime import build_deps
from conversation.worker_main import run_once
from tests.conftest import sample_card


def _app(settings: Settings, **kwargs):
    engine = make_engine("sqlite://")
    create_schema(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    clock = FrozenClock(datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc))
    deps = build_deps(
        settings,
        session_factory=factory,
        clock=clock,
        crm_client=FakeCrmClient(),
        **kwargs,
    )
    return TestClient(create_app(deps)), deps


def _sign(secret: str, body: bytes, stamp: str) -> dict[str, str]:
    digest = hmac.new(secret.encode(), f"{stamp}:{body.decode()}".encode(), hashlib.sha256).hexdigest()
    return {
        "X-Conversation-Timestamp": stamp,
        "X-Conversation-Signature": f"sha256={digest}",
        "Content-Type": "application/json",
    }


def _meta(body: bytes, secret: str) -> dict[str, str]:
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return {"X-Hub-Signature-256": f"sha256={digest}", "Content-Type": "application/json"}


def _tenant(client: TestClient, *, channel: str = "whatsapp", external_id: str = "15551212") -> str:
    created = client.post(
        "/admin/tenants",
        headers={"Authorization": "Bearer operator-test-token"},
        json={
            "name": "Acme",
            "deployment_id": "local",
            "twenty_workspace_id": "ws-acme",
            "twenty_base_url": "http://127.0.0.1:9",
            "twenty_api_key_ref": "env://TWENTY_API_KEY",
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
            "channel": channel,
            "external_id": external_id,
        },
    )
    assert member.status_code == 200
    return tenant_id


def test_whatsapp_challenge_and_meta_signature():
    settings = Settings(
        operator_token="operator-test-token",
        webhook_shared_secret="webhook-test-secret",
        whatsapp_verify_token="verify-me",
        whatsapp_app_secret="app-secret",
        database_url="sqlite://",
        twenty_base_url="http://127.0.0.1:9",
    )
    client, _deps = _app(settings)
    ok = client.get("/webhooks/whatsapp", params={"hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "1158201444"})
    assert ok.status_code == 200
    assert ok.text == "1158201444"
    bad = client.get("/webhooks/whatsapp", params={"hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1"})
    assert bad.status_code == 403

    _tenant(client)
    payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "changes": [
                    {
                        "value": {
                            "messages": [
                                {"from": "15551212", "id": "wamid.META", "timestamp": "1", "type": "text", "text": {"body": "hello"}}
                            ]
                        }
                    }
                ]
            }
        ],
    }
    raw = json.dumps(payload).encode()
    rejected = client.post("/webhooks/whatsapp", content=raw, headers={"X-Hub-Signature-256": "sha256=00", "Content-Type": "application/json"})
    assert rejected.status_code == 401
    accepted = client.post("/webhooks/whatsapp", content=raw, headers=_meta(raw, "app-secret"))
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "queued"
    again = client.post("/webhooks/whatsapp", content=raw, headers=_meta(raw, "app-secret"))
    assert again.json()["status"] == "duplicate"


def test_teams_rejects_unsigned_and_accepts_adaptive_card():
    settings = Settings(
        operator_token="operator-test-token",
        webhook_shared_secret="webhook-test-secret",
        database_url="sqlite://",
        twenty_base_url="http://127.0.0.1:9",
    )
    client, deps = _app(settings)
    naked = client.post("/webhooks/teams", json={"type": "message", "text": "hi"})
    assert naked.status_code == 401
    _tenant(client, channel="teams", external_id="29:ada")
    activity = {
        "type": "message",
        "id": "act-1",
        "serviceUrl": "https://smba.trafficmanager.net/amer/",
        "channelId": "msteams",
        "from": {"id": "29:ada", "name": "Ada"},
        "conversation": {"conversationType": "personal", "id": "a:1"},
        "recipient": {"id": "28:bot"},
        "text": "",
        "value": sample_card(),
    }
    raw = json.dumps(activity).encode()
    stamp = str(int(deps.clock.now().timestamp()))
    accepted = client.post("/webhooks/teams", content=raw, headers=_sign("webhook-test-secret", raw, stamp))
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "queued"
    group = dict(activity)
    group["id"] = "act-group"
    group["conversation"] = {"conversationType": "channel", "id": "19:group"}
    group_raw = json.dumps(group).encode()
    ignored = client.post("/webhooks/teams", content=group_raw, headers=_sign("webhook-test-secret", group_raw, stamp))
    assert ignored.status_code == 200
    assert ignored.json()["reason"] == "private_chat_only"


def test_teams_jwt_round_trip():
    from cryptography.hazmat.primitives.asymmetric import rsa

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_jwk = json.loads(RSAAlgorithm.to_jwk(private_key.public_key()))
    public_jwk["kid"] = "k1"
    public_jwk["endorsements"] = ["msteams"]
    app_id = "11111111-1111-1111-1111-111111111111"
    service_url = "https://smba.trafficmanager.net/amer/"
    now = int(time.time())
    token = jwt.encode(
        {
            "iss": CONNECTOR_ISSUER,
            "aud": app_id,
            "exp": now + 600,
            "serviceurl": service_url,
            "appid": app_id,
        },
        private_key,
        algorithm="RS256",
        headers={"kid": "k1"},
    )
    from conversation.channels.teams_auth import BotFrameworkVerifier

    verifier = BotFrameworkVerifier(app_id, jwks=[public_jwk])
    settings = Settings(
        operator_token="operator-test-token",
        webhook_shared_secret="webhook-test-secret",
        teams_app_id=app_id,
        teams_app_password="not-used-for-inbound",
        database_url="sqlite://",
        twenty_base_url="http://127.0.0.1:9",
    )
    client, deps = _app(settings, teams_verifier=verifier)
    _tenant(client, channel="teams", external_id="29:ada")
    activity = {
        "type": "message",
        "id": "act-jwt",
        "serviceUrl": service_url,
        "channelId": "msteams",
        "from": {"id": "29:ada"},
        "conversation": {"conversationType": "personal", "id": "a:1"},
        "recipient": {"id": "28:bot"},
        "text": "hello",
    }
    raw = json.dumps(activity).encode()
    stamp = str(int(deps.clock.now().timestamp()))
    downgrade = client.post("/webhooks/teams", content=raw, headers=_sign("webhook-test-secret", raw, stamp))
    assert downgrade.status_code == 401
    accepted = client.post(
        "/webhooks/teams",
        content=raw,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "queued"
    forged = client.post(
        "/webhooks/teams",
        content=raw,
        headers={"Authorization": "Bearer not-a-token", "Content-Type": "application/json"},
    )
    assert forged.status_code == 401


def test_outbound_does_not_call_meta_when_unconfigured_or_outside_window(world):
    from tests.conftest import open_tenant

    tenant, _admin, sales = open_tenant(world, "acme", "15551212")
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"messages": [{"id": "wamid.out"}]})

    transport = httpx.MockTransport(handler)
    quiet = Settings(database_url="sqlite://", whatsapp_access_token="", whatsapp_phone_number_id="")
    result = OutboundService(world.session, quiet, world.clock, transport).send_to_membership(
        tenant.id, sales.id, "hello", kind="preview"
    )
    assert result.status == "unconfigured"
    assert result.error_code == "whatsapp_unconfigured"
    assert calls == []

    configured = Settings(
        database_url="sqlite://",
        whatsapp_access_token="token",
        whatsapp_phone_number_id="12345",
        whatsapp_template_name="",
    )
    outside = OutboundService(world.session, configured, world.clock, transport).send_to_membership(
        tenant.id, sales.id, "digest", kind="digest"
    )
    assert outside.status == "error"
    assert outside.error_code == "whatsapp_template_required"
    assert calls == []

    world.session.add(
        ConversationReference(
            tenant_id=tenant.id,
            membership_id=sales.id,
            channel="whatsapp",
            external_id="15551212",
            service_url="",
            conversation_id="",
            reference={},
            last_inbound_at=world.clock.now(),
        )
    )
    world.session.flush()
    sent = OutboundService(world.session, configured, world.clock, transport).send_to_membership(
        tenant.id, sales.id, "inside window", kind="preview"
    )
    assert sent.status == "sent"
    assert calls[-1].url.path.endswith("/12345/messages")
    assert json.loads(calls[-1].content)["type"] == "text"
    assert calls[-1].headers["authorization"].startswith("Bearer ")

    aged = world.session.query(ConversationReference).one()
    aged.last_inbound_at = world.clock.now() - timedelta(hours=30)
    world.session.flush()
    templated = Settings(
        database_url="sqlite://",
        whatsapp_access_token="token",
        whatsapp_phone_number_id="12345",
        whatsapp_template_name="morning_digest",
        whatsapp_template_language="en",
    )
    digest = OutboundService(world.session, templated, world.clock, transport).send_to_membership(
        tenant.id, sales.id, "Follow-ups", kind="digest"
    )
    assert digest.status == "sent"
    body = json.loads(calls[-1].content)
    assert body["type"] == "template"
    assert body["template"]["name"] == "morning_digest"
    assert body["to"] == "+15551212"


def test_form_intake_requires_signature():
    settings = Settings(
        operator_token="operator-test-token",
        webhook_shared_secret="webhook-test-secret",
        database_url="sqlite://",
        twenty_base_url="http://127.0.0.1:9",
    )
    client, deps = _app(settings)
    tenant_id = _tenant(client)
    listed = client.post(
        f"/admin/tenants/{tenant_id}/memberships",
        headers={"Authorization": "Bearer operator-test-token"},
        json={"display_name": "Ops", "role": "client_admin"},
    )
    # salesperson from _tenant is the actor; fetch via a second membership is unnecessary.
    # Use the salesperson created with the tenant: the admin route does not list ids.
    # Recreate source using the only salesperson by reading nothing — post source after looking up via redeem is heavier.
    # The first membership response was discarded. Create the source with a fresh salesperson id from a dedicated call.
    assert listed.status_code == 200
    sales = client.post(
        f"/admin/tenants/{tenant_id}/memberships",
        headers={"Authorization": "Bearer operator-test-token"},
        json={"display_name": "Ada 2", "role": "salesperson"},
    )
    source = client.post(
        f"/admin/tenants/{tenant_id}/intake-sources",
        headers={"Authorization": "Bearer operator-test-token"},
        json={"alias": "opaque-form", "mode": "review", "actor_membership_id": sales.json()["id"]},
    )
    assert source.status_code == 200
    source_id = source.json()["id"]
    payload = {
        "message_id": "form-1",
        "body": "Name: Ada Lovelace\nEmail: ada@example.com\nCompany: Analytical Engines\nDomain: engines.example\nStage: NEW\nMessage: Booth",
    }
    raw = json.dumps(payload).encode()
    unsigned = client.post(f"/intake/forms/{source_id}", content=raw, headers={"Content-Type": "application/json"})
    assert unsigned.status_code == 401
    stamp = str(int(deps.clock.now().timestamp()))
    headers = _sign("webhook-test-secret", raw, stamp)
    accepted = client.post(f"/intake/forms/{source_id}", content=raw, headers=headers)
    assert accepted.status_code == 200
    assert accepted.json()["route"] == "review"
    assert accepted.json()["draft_id"]


def test_health_reports_wiring_without_secrets():
    secret = "super-secret-value-xyz"
    settings = Settings(
        operator_token="operator-test-token",
        webhook_shared_secret="webhook-test-secret",
        whatsapp_app_secret=secret,
        database_url="sqlite://",
        twenty_base_url="http://127.0.0.1:9",
        queue_backend="memory",
    )
    client, _deps = _app(settings)
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["wiring"]["database"] == "ok"
    assert body["wiring"]["redis"] == "memory"
    assert body["wiring"]["twenty"] == "unreachable"
    assert body["wiring"]["whatsapp_configured"] is False
    assert body["wiring"]["teams_configured"] is False
    assert secret not in response.text


def test_worker_retries_then_dead_letters(monkeypatch):
    from conversation.worker import InboundWorker

    settings = Settings(
        operator_token="operator-test-token",
        webhook_shared_secret="x",
        database_url="sqlite://",
        twenty_base_url="http://127.0.0.1:9",
        worker_max_attempts=2,
        queue_backend="memory",
    )
    _client, deps = _app(settings)

    def explode(self, item):
        raise RuntimeError("downstream")

    monkeypatch.setattr(InboundWorker, "process_item", explode)
    deps.queue.enqueue({"channel": "whatsapp", "message_id": "m-retry", "attempts": 0, "tenant_id": str(uuid.uuid4())})
    assert run_once(deps) is True
    waiting = deps.queue._items
    assert len(waiting) == 1
    assert waiting[0]["attempts"] == 1
    waiting[0]["not_before"] = 0
    assert run_once(deps) is True
    assert deps.queue._items == []
