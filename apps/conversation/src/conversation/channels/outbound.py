from __future__ import annotations

import logging
import re
import time
import uuid
from dataclasses import dataclass
from datetime import timedelta
from urllib.parse import quote, urlparse

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from conversation.clock import Clock, as_utc
from conversation.config import Settings
from conversation.models import ChannelBinding, ConversationReference

logger = logging.getLogger(__name__)

_GRAPH_VERSION = re.compile(r"v\d+\.\d+")
_TENANT_ID = re.compile(r"[0-9a-fA-F-]{36}")
_SERVICE_HOSTS = ("botframework.com", "trafficmanager.net", "skype.com")


@dataclass(frozen=True)
class DeliveryResult:
    status: str
    error_code: str
    detail: str


class OutboundService:
    """Send only to an active channel binding. Unconfigured channels return an error state.

    Meta is not called unless the access token and phone number id are set.
    Teams is not called unless the app id, password, and a stored conversation
    reference are set.
    """

    def __init__(
        self,
        session: Session,
        settings: Settings,
        clock: Clock,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.session = session
        self.settings = settings
        self.clock = clock
        self.transport = transport
        self._token: str = ""
        self._token_until: float = 0.0

    def send_to_membership(self, tenant_id: uuid.UUID, membership_id: uuid.UUID, body: str, *, kind: str) -> DeliveryResult:
        bindings = list(
            self.session.scalars(
                select(ChannelBinding)
                .where(
                    ChannelBinding.tenant_id == tenant_id,
                    ChannelBinding.membership_id == membership_id,
                    ChannelBinding.status == "active",
                )
                .order_by(ChannelBinding.created_at.desc())
            ).all()
        )
        if not bindings:
            return DeliveryResult("refused", "not_allowlisted", "no active employee channel binding")
        whatsapp = next((row for row in bindings if row.channel == "whatsapp"), None)
        teams = next((row for row in bindings if row.channel == "teams"), None)
        if whatsapp is not None and self._whatsapp_outbound_configured():
            return self._send_whatsapp(whatsapp, body, kind=kind)
        if teams is not None and self._teams_outbound_configured():
            return self._send_teams(teams, body)
        if whatsapp is not None:
            return DeliveryResult("unconfigured", "whatsapp_unconfigured", "WhatsApp Cloud API credentials are not set")
        if teams is not None:
            return DeliveryResult("unconfigured", "teams_unconfigured", "Teams bot credentials are not set")
        return DeliveryResult("refused", "not_allowlisted", "membership has no WhatsApp or Teams binding")

    def _whatsapp_outbound_configured(self) -> bool:
        return bool(self.settings.whatsapp_access_token and self.settings.whatsapp_phone_number_id)

    def _teams_outbound_configured(self) -> bool:
        return bool(self.settings.teams_app_id and self.settings.teams_app_password)

    def _send_whatsapp(self, binding: ChannelBinding, body: str, *, kind: str) -> DeliveryResult:
        phone_id = self.settings.whatsapp_phone_number_id.strip()
        version = self.settings.whatsapp_graph_version.strip()
        if not phone_id.isdigit() or not _GRAPH_VERSION.fullmatch(version):
            return DeliveryResult("error", "whatsapp_config_invalid", "phone number id or graph version is invalid")
        digits = "".join(ch for ch in binding.external_id if ch.isdigit())
        if not digits:
            return DeliveryResult("refused", "not_allowlisted", "whatsapp binding has no wa_id")
        # Cloud API prepends the business country code when `to` has no plus.
        recipient = f"+{digits}"
        reference = self._reference(binding)
        within = self._within_window(reference)
        if kind == "digest" and not within:
            template = self.settings.whatsapp_template_name.strip()
            if not template:
                return DeliveryResult(
                    "error",
                    "whatsapp_template_required",
                    "outside the 24-hour window and WHATSAPP_TEMPLATE_NAME is empty",
                )
            payload = {
                "messaging_product": "whatsapp",
                "recipient_type": "individual",
                "to": recipient,
                "type": "template",
                "template": {
                    "name": template,
                    "language": {"code": self.settings.whatsapp_template_language or "en"},
                    "components": [
                        {"type": "body", "parameters": [{"type": "text", "text": body[:1024]}]}
                    ],
                },
            }
        else:
            payload = {
                "messaging_product": "whatsapp",
                "recipient_type": "individual",
                "to": recipient,
                "type": "text",
                "text": {"preview_url": False, "body": body[:4096]},
            }
        url = f"https://graph.facebook.com/{version}/{phone_id}/messages"
        return self._post_json(
            url,
            payload,
            headers={"Authorization": f"Bearer {self.settings.whatsapp_access_token}"},
            error_code="whatsapp_send_failed",
        )

    def _send_teams(self, binding: ChannelBinding, body: str) -> DeliveryResult:
        reference = self._reference(binding)
        if reference is None or not reference.service_url or not reference.conversation_id:
            return DeliveryResult(
                "error",
                "teams_reference_missing",
                "employee has not opened a personal chat with the bot",
            )
        if not _allowed_service_url(reference.service_url):
            return DeliveryResult("error", "teams_service_url_rejected", "stored service URL is not a Bot Connector host")
        tenant = self.settings.teams_tenant_id.strip()
        if tenant and not _TENANT_ID.fullmatch(tenant):
            return DeliveryResult("error", "teams_tenant_invalid", "TEAMS_TENANT_ID is not a tenant id")
        try:
            token = self._bot_token()
        except Exception as exc:
            logger.warning("teams token request failed: %s", type(exc).__name__)
            return DeliveryResult("error", "teams_token_failed", "bot token request failed")
        stored = reference.reference or {}
        activity = {
            "type": "message",
            "text": body[:4000],
            "from": stored.get("recipient") or {"id": self.settings.teams_app_id},
            "recipient": stored.get("from") or {"id": binding.external_id},
            "conversation": stored.get("conversation") or {"id": reference.conversation_id},
        }
        url = reference.service_url.rstrip("/") + "/v3/conversations/" + quote(reference.conversation_id, safe="") + "/activities"
        return self._post_json(
            url,
            activity,
            headers={"Authorization": f"Bearer {token}"},
            error_code="teams_send_failed",
        )

    def _bot_token(self) -> str:
        now = time.time()
        if self._token and now < self._token_until - 60:
            return self._token
        tenant = self.settings.teams_tenant_id.strip() or "botframework.com"
        url = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
        response = self._client().post(
            url,
            data={
                "grant_type": "client_credentials",
                "client_id": self.settings.teams_app_id,
                "client_secret": self.settings.teams_app_password,
                "scope": "https://api.botframework.com/.default",
            },
        )
        response.raise_for_status()
        body = response.json()
        token = str(body.get("access_token") or "")
        if not token:
            raise RuntimeError("token response had no access_token")
        self._token = token
        self._token_until = now + int(body.get("expires_in") or 300)
        return token

    def _post_json(self, url: str, payload: dict, *, headers: dict, error_code: str) -> DeliveryResult:
        try:
            response = self._client().post(url, json=payload, headers=headers)
        except Exception as exc:
            logger.warning("outbound request failed: %s", type(exc).__name__)
            return DeliveryResult("error", error_code, type(exc).__name__)
        if response.status_code >= 400:
            detail = _safe_error(response)
            logger.warning("outbound provider status %s", response.status_code)
            return DeliveryResult("error", error_code, detail)
        return DeliveryResult("sent", "", "accepted")

    def _client(self) -> httpx.Client:
        return httpx.Client(transport=self.transport, timeout=20.0, trust_env=False)

    def _reference(self, binding: ChannelBinding) -> ConversationReference | None:
        return self.session.scalar(
            select(ConversationReference).where(
                ConversationReference.tenant_id == binding.tenant_id,
                ConversationReference.channel == binding.channel,
                ConversationReference.external_id == binding.external_id,
            )
        )

    def _within_window(self, reference: ConversationReference | None) -> bool:
        if reference is None:
            return False
        age = as_utc(self.clock.now()) - as_utc(reference.last_inbound_at)
        return age <= timedelta(hours=self.settings.session_window_hours)


class RoutingChannelPort:
    def __init__(self, outbound: OutboundService) -> None:
        self.outbound = outbound

    def send_digest(self, *, tenant_id: uuid.UUID, membership_id: uuid.UUID, body: str) -> None:
        result = self.outbound.send_to_membership(tenant_id, membership_id, body, kind="digest")
        if result.status != "sent":
            raise RuntimeError(f"{result.status}:{result.error_code}:{result.detail}")


def _allowed_service_url(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host:
        return False
    return any(host == suffix or host.endswith("." + suffix) for suffix in _SERVICE_HOSTS)


def _safe_error(response: httpx.Response) -> str:
    try:
        body = response.json()
    except Exception:
        return f"HTTP {response.status_code}"
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict) and error.get("message"):
            return f"HTTP {response.status_code}: {error.get('message')}"[:300]
    return f"HTTP {response.status_code}"
