from __future__ import annotations

import time
from urllib.parse import urlparse

import httpx
import jwt
from jwt.algorithms import RSAAlgorithm

from conversation.errors import DomainError

CONNECTOR_OPENID = "https://login.botframework.com/v1/.well-known/openidconfiguration"
EMULATOR_OPENID = "https://login.microsoftonline.com/botframework.com/v2.0/.well-known/openid-configuration"
CONNECTOR_ISSUER = "https://api.botframework.com"
EMULATOR_ISSUER = "https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/"
_CACHE_SECONDS = 24 * 60 * 60


def _normalize_service_url(url: str) -> str:
    parsed = urlparse(url.strip())
    path = parsed.path.rstrip("/")
    return f"{parsed.scheme.lower()}://{(parsed.netloc or '').lower()}{path}"


class BotFrameworkVerifier:
    """Validate Bot Connector JWTs for a multi-tenant bot.

    Inbound tokens are checked against the connector OpenID document
    (issuer https://api.botframework.com, audience = Microsoft App ID) and the
    serviceUrl claim must match the activity. Emulator tokens are a second path
    with the Bot Framework tenant issuer. A static JWKS skips the network for tests.
    """

    def __init__(
        self,
        app_id: str,
        *,
        jwks: list[dict] | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        self.app_id = app_id
        self._static = jwks
        self._client = client or httpx.Client(timeout=10.0, trust_env=False)
        self._cache: dict[str, tuple[float, list[dict]]] = {}

    def verify(self, token: str, *, service_url: str, channel_id: str) -> dict:
        if not self.app_id:
            raise DomainError("unauthorized", "teams app id is not configured", 401)
        if not token:
            raise DomainError("unauthorized", "teams bearer token missing", 401)
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise DomainError("unauthorized", "teams token is not a jwt", 401) from exc
        if header.get("alg") != "RS256":
            raise DomainError("unauthorized", "teams token algorithm rejected", 401)
        kid = str(header.get("kid") or "")
        saw_key = False
        for issuer, keys in self._key_sets():
            key = next((item for item in keys if str(item.get("kid") or "") == kid), None)
            if key is None:
                continue
            saw_key = True
            endorsements = [str(item) for item in (key.get("endorsements") or [])]
            material = {name: value for name, value in key.items() if name != "endorsements"}
            try:
                public_key = RSAAlgorithm.from_jwk(material)
                claims = jwt.decode(
                    token,
                    public_key,
                    algorithms=["RS256"],
                    audience=self.app_id,
                    issuer=issuer,
                    leeway=300,
                    options={"require": ["exp", "iss", "aud"]},
                )
            except jwt.PyJWTError:
                continue
            self._check_app(claims)
            self._check_service_url(claims, service_url)
            self._check_channel(issuer, channel_id, endorsements)
            return claims
        if not saw_key:
            raise DomainError("unauthorized", "teams signing key not found", 401)
        raise DomainError("unauthorized", "teams token rejected", 401)

    def _key_sets(self) -> list[tuple[str, list[dict]]]:
        if self._static is not None:
            return [(CONNECTOR_ISSUER, self._static)]
        return [
            (CONNECTOR_ISSUER, self._fetch(CONNECTOR_OPENID)),
            (EMULATOR_ISSUER, self._fetch(EMULATOR_OPENID)),
        ]

    def _fetch(self, openid_url: str) -> list[dict]:
        cached = self._cache.get(openid_url)
        now = time.time()
        if cached and now - cached[0] < _CACHE_SECONDS:
            return cached[1]
        try:
            metadata = self._client.get(openid_url)
            metadata.raise_for_status()
            jwks_uri = str(metadata.json().get("jwks_uri") or "")
            if not jwks_uri.startswith("https://"):
                raise DomainError("unauthorized", "teams jwks endpoint rejected", 401)
            keys = self._client.get(jwks_uri)
            keys.raise_for_status()
            body = keys.json().get("keys") or []
        except DomainError:
            raise
        except Exception as exc:
            raise DomainError("unauthorized", "teams signing keys unavailable", 401) from exc
        if not isinstance(body, list):
            raise DomainError("unauthorized", "teams signing keys unavailable", 401)
        parsed = [item for item in body if isinstance(item, dict)]
        self._cache[openid_url] = (now, parsed)
        return parsed

    def _check_app(self, claims: dict) -> None:
        for name in ("appid", "azp"):
            value = claims.get(name)
            if value and str(value) != self.app_id:
                raise DomainError("unauthorized", "teams token app id mismatch", 401)

    def _check_service_url(self, claims: dict, service_url: str) -> None:
        claimed = claims.get("serviceurl") or claims.get("serviceUrl")
        if not claimed or not service_url:
            raise DomainError("unauthorized", "teams serviceUrl missing", 401)
        if _normalize_service_url(str(claimed)) != _normalize_service_url(service_url):
            raise DomainError("unauthorized", "teams serviceUrl mismatch", 401)

    def _check_channel(self, issuer: str, channel_id: str, endorsements: list[str]) -> None:
        if issuer == CONNECTOR_ISSUER and channel_id != "msteams":
            raise DomainError("unauthorized", "teams channel rejected", 401)
        if endorsements and channel_id not in endorsements:
            raise DomainError("unauthorized", "teams channel endorsement missing", 401)
