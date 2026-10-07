"""Pydantic mirrors of the TypeScript Zod contracts (src/common/schemas). `extra="forbid"` everywhere: a model that
tries to smuggle a tenant, record id, role or tool into its output fails validation and is rejected (fail closed)."""
from __future__ import annotations

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


Text = Field(default=None, max_length=2000)

IntentName = Literal[
    "capture_lead", "search", "update_stage", "add_note", "create_task", "reschedule",
    "assign", "archive", "restore", "summary", "clarify", "smalltalk", "unknown",
]
SummaryType = Literal["today_meetings", "overdue_followups", "company_summary", "team_pipeline", "won_this_month", "my_pipeline"]


class LlmPerson(Strict):
    name: Optional[str] = Text
    title: Optional[str] = Text
    email: Optional[str] = Text
    phone: Optional[str] = Text
    companyName: Optional[str] = Text
    website: Optional[str] = Text
    address: Optional[str] = Text


class LlmTask(Strict):
    title: str = Field(max_length=2000)
    type: Literal["follow_up", "meeting", "call", "task"]
    # Natural-language date as written ("next Tuesday"); resolved by deterministic code, never by the model.
    dateExpression: Optional[str] = Text
    timeExpression: Optional[str] = Text
    location: Optional[str] = Text


class LlmIntent(Strict):
    intent: IntentName
    person: Optional[LlmPerson] = None
    companyName: Optional[str] = Text
    opportunityTitle: Optional[str] = Text
    interest: Optional[str] = Text
    amount: Optional[float] = Field(default=None, ge=0)
    currency: Optional[str] = Field(default=None, min_length=3, max_length=3)
    notes: Optional[List[str]] = Field(default=None, max_length=5)
    tasks: Optional[List[LlmTask]] = Field(default=None, max_length=5)
    targetQuery: Optional[str] = Text
    newStage: Optional[str] = Text
    newOwnerName: Optional[str] = Text
    dateExpression: Optional[str] = Text
    timeExpression: Optional[str] = Text
    summaryType: Optional[SummaryType] = None
    clarification: Optional[str] = Text
    confidence: Optional[float] = Field(default=None, ge=0, le=1)


class CardExtraction(Strict):
    name: Optional[str] = Text
    title: Optional[str] = Text
    company: Optional[str] = Text
    phones: List[str] = Field(default_factory=list, max_length=5)
    email: Optional[str] = Text
    website: Optional[str] = Text
    address: Optional[str] = Text
    legible: bool = True
    uncertainFields: List[str] = Field(default_factory=list)


class EmailExtraction(Strict):
    name: Optional[str] = Text
    email: Optional[str] = Text
    phone: Optional[str] = Text
    company: Optional[str] = Text
    message: Optional[str] = Field(default=None, max_length=5000)
    evidence: Dict[str, str] = Field(default_factory=dict)


# ── request/response envelopes ───────────────────────────────────────────────────
class IntentContext(Strict):
    nowIso: str
    timezone: str
    stageLabels: List[str] = Field(default_factory=list, max_length=30)
    hasActiveDraft: bool = False
    cardPresent: bool = False


class IntentRequest(Strict):
    text: str
    context: IntentContext


class ImageRequest(Strict):
    imageBase64: str
    mimeType: Literal["image/jpeg", "image/png"]


class AudioRequest(Strict):
    audioBase64: str
    mimeType: str


class TextRequest(Strict):
    text: str


class Usage(Strict):
    provider: str
    llmTokens: Optional[int] = None
    sttMinutes: Optional[float] = None
    visionCalls: Optional[int] = None
