from __future__ import annotations

from typing import Protocol

import httpx
from pydantic import ValidationError

from conversation.channels.events import NormalizedInboundEvent
from conversation.crm.proposal import ActionProposal, proposal_from_card
from conversation.errors import DomainError


class Extractor(Protocol):
    def extract(self, event: NormalizedInboundEvent) -> ActionProposal | None: ...


class FixtureExtractor:
    """Deterministic extractor. Uses a structured card when the adapter supplied one.

    No OCR or speech vendor is called. Plain text without a card returns None
    (the draft stays in collecting).
    """

    def extract(self, event: NormalizedInboundEvent) -> ActionProposal | None:
        if not event.card:
            return None
        try:
            return proposal_from_card(event.card)
        except ValidationError as exc:
            raise DomainError("invalid_proposal", "card contains fields that are not in the manifest") from exc


class HttpExtractor:
    """Optional model endpoint. The response is still parsed as a typed proposal.

    The request body is the utterance only. Tenant ids and API keys are not sent.
    """

    def __init__(self, url: str, transport: httpx.BaseTransport | None = None) -> None:
        self.url = url
        self.transport = transport

    def extract(self, event: NormalizedInboundEvent) -> ActionProposal | None:
        if event.card and "action" not in event.card:
            try:
                return proposal_from_card(event.card)
            except ValidationError as exc:
                raise DomainError("invalid_proposal", "card contains fields that are not in the manifest") from exc
        response = httpx.post(
            self.url,
            json={"channel": event.channel, "text": event.text or ""},
            timeout=30.0,
            transport=self.transport,
            trust_env=False,
        )
        if response.status_code >= 500:
            raise RuntimeError(f"extractor HTTP {response.status_code}")
        if response.status_code == 204 or not response.content:
            return None
        response.raise_for_status()
        body = response.json()
        proposal = body.get("proposal") if isinstance(body, dict) else None
        if not isinstance(proposal, dict):
            return None
        try:
            return proposal_from_card(proposal)
        except ValidationError as exc:
            raise DomainError("invalid_proposal", "extractor returned fields that are not in the manifest") from exc
