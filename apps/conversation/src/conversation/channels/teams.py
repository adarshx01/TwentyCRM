from __future__ import annotations

from conversation.channels.events import NormalizedInboundEvent


class IgnoredActivity(Exception):
    def __init__(self, reason: str = "ignored") -> None:
        super().__init__(reason)
        self.reason = reason


class PrivateChatOnly(IgnoredActivity):
    """Teams capture is personal chat only. Group and channel posts are ignored."""

    def __init__(self) -> None:
        super().__init__("private_chat_only")


def is_activity(payload: dict) -> bool:
    return payload.get("type") in {"message", "invoke"} or "serviceUrl" in payload


def parse_teams_activity(payload: dict) -> NormalizedInboundEvent:
    kind = payload.get("type")
    if kind not in {"message", "invoke"}:
        raise IgnoredActivity()
    conversation = payload.get("conversation") if isinstance(payload.get("conversation"), dict) else {}
    channel_id = str(payload.get("channelId") or "")
    conv_type = conversation.get("conversationType")
    if channel_id == "msteams" and conv_type != "personal":
        raise PrivateChatOnly()
    if conv_type not in {None, "personal"}:
        raise PrivateChatOnly()
    sender = payload.get("from") if isinstance(payload.get("from"), dict) else {}
    external_user_id = str(sender.get("id") or "")
    message_id = str(payload.get("id") or "")
    value = payload.get("value")
    card = value if isinstance(value, dict) else None
    text = payload.get("text")
    text = text.strip() if isinstance(text, str) else None
    if not text and card is None:
        raise PrivateChatOnly()
    reference = {
        "serviceUrl": str(payload.get("serviceUrl") or ""),
        "channelId": channel_id,
        "conversationId": str(conversation.get("id") or ""),
        "from": sender,
        "recipient": payload.get("recipient") if isinstance(payload.get("recipient"), dict) else {},
        "conversation": conversation,
    }
    return NormalizedInboundEvent(
        channel="teams",
        external_user_id=external_user_id,
        message_id=message_id,
        text=text,
        card=card,
        conversation_reference=reference,
    )


def legacy_envelope(payload: dict, channel: str) -> NormalizedInboundEvent:
    card = payload.get("card")
    claimed = payload.get("tenant_id")
    return NormalizedInboundEvent(
        channel=channel,
        external_user_id=str(payload.get("external_user_id") or ""),
        message_id=str(payload.get("message_id") or ""),
        text=payload.get("text") if isinstance(payload.get("text"), str) else None,
        card=card if isinstance(card, dict) else None,
        claimed_tenant_id=str(claimed) if claimed else None,
    )
