from __future__ import annotations

import json

from conversation.channels.events import NormalizedInboundEvent


def _json_object(value: object) -> dict | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text.startswith("{"):
        return None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def parse_whatsapp_payload(payload: dict) -> list[NormalizedInboundEvent]:
    """Normalize Cloud API `messages` entries. Status callbacks yield nothing."""
    events: list[NormalizedInboundEvent] = []
    for entry in payload.get("entry") or []:
        if not isinstance(entry, dict):
            continue
        for change in entry.get("changes") or []:
            if not isinstance(change, dict):
                continue
            value = change.get("value") or {}
            if not isinstance(value, dict):
                continue
            for message in value.get("messages") or []:
                if isinstance(message, dict):
                    event = _message(message)
                    if event is not None:
                        events.append(event)
    return events


def _message(message: dict) -> NormalizedInboundEvent | None:
    message_id = str(message.get("id") or "")
    sender = str(message.get("from") or "")
    if not message_id or not sender:
        return None
    text: str | None = None
    card: dict | None = None
    kind = message.get("type")
    if kind == "text":
        body = message.get("text") or {}
        if isinstance(body, dict):
            text = body.get("body")
    elif kind == "interactive":
        interactive = message.get("interactive") or {}
        if isinstance(interactive, dict):
            reply = interactive.get("button_reply") or interactive.get("list_reply") or {}
            if isinstance(reply, dict):
                card = _json_object(reply.get("id"))
                title = reply.get("title") or reply.get("description")
                text = title if isinstance(title, str) else None
            nfm = interactive.get("nfm_reply") or {}
            if isinstance(nfm, dict) and nfm.get("response_json"):
                card = _json_object(nfm.get("response_json")) or card
    elif kind == "button":
        button = message.get("button") or {}
        if isinstance(button, dict):
            card = _json_object(button.get("payload"))
            label = button.get("text")
            text = label if isinstance(label, str) else None
    if isinstance(text, str):
        embedded = _json_object(text)
        if embedded and card is None and ("person" in embedded or "action" in embedded):
            card = embedded
    return NormalizedInboundEvent(
        channel="whatsapp",
        external_user_id=sender,
        message_id=message_id,
        text=text if isinstance(text, str) else None,
        card=card,
    )
