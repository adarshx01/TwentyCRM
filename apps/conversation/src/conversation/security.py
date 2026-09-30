from __future__ import annotations

import hashlib
import hmac

from conversation.errors import DomainError


def verify_hmac_signature(
    *,
    secret: str,
    timestamp: str | None,
    signature: str | None,
    raw_body: bytes,
    now_epoch: int,
    max_skew_seconds: int,
) -> None:
    if not secret or not timestamp or not signature:
        raise DomainError("unauthorized", "webhook signature missing", 401)
    try:
        stamp = int(timestamp)
    except ValueError as exc:
        raise DomainError("unauthorized", "webhook timestamp invalid", 401) from exc
    if abs(now_epoch - stamp) > max_skew_seconds:
        raise DomainError("unauthorized", "webhook timestamp expired", 401)
    payload = raw_body.decode("utf-8")
    expected = hmac.new(secret.encode(), f"{timestamp}:{payload}".encode(), hashlib.sha256).hexdigest()
    received = signature.strip()
    if received.lower().startswith("sha256="):
        received = received.split("=", 1)[1].strip()
    try:
        ok = hmac.compare_digest(bytes.fromhex(expected), bytes.fromhex(received))
    except ValueError as exc:
        raise DomainError("unauthorized", "webhook signature invalid", 401) from exc
    if not ok:
        raise DomainError("unauthorized", "webhook signature mismatch", 401)


def verify_meta_signature(*, secret: str, signature: str | None, raw_body: bytes) -> None:
    """Meta X-Hub-Signature-256 is HMAC-SHA256 of the raw body, keyed with the app secret."""
    if not secret or not signature:
        raise DomainError("unauthorized", "whatsapp signature missing", 401)
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    received = signature.strip()
    if received.lower().startswith("sha256="):
        received = received.split("=", 1)[1].strip()
    try:
        ok = hmac.compare_digest(bytes.fromhex(expected), bytes.fromhex(received))
    except ValueError as exc:
        raise DomainError("unauthorized", "whatsapp signature invalid", 401) from exc
    if not ok:
        raise DomainError("unauthorized", "whatsapp signature mismatch", 401)


def require_operator(token: str, authorization: str | None) -> None:
    if not token:
        raise DomainError("unauthorized", "operator token is not configured", 401)
    if not authorization or not authorization.startswith("Bearer "):
        raise DomainError("unauthorized", "operator token required", 401)
    presented = authorization.removeprefix("Bearer ").strip()
    if not hmac.compare_digest(presented, token):
        raise DomainError("unauthorized", "operator token rejected", 401)
