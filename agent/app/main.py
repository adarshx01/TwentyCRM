from __future__ import annotations

import base64
import binascii
import hmac
import logging
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

from .agent import ConversationAgent, OutputRejected
from .schemas import AudioRequest, ImageRequest, IntentRequest, TextRequest
from .settings import Settings, get_settings

log = logging.getLogger("agent")


def create_app(agent: Optional[ConversationAgent] = None, settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(title="CRM Bee conversation agent", version="1.0.0", docs_url=None, redoc_url=None, openapi_url=None)
    holder = {"agent": agent}

    def get_agent() -> ConversationAgent:
        if holder["agent"] is None:
            holder["agent"] = ConversationAgent(settings)
        return holder["agent"]

    def auth(authorization: str = Header(default="")) -> None:
        # Constant-time comparison; the service refuses to run unauthenticated.
        expected = f"Bearer {settings.agent_token}"
        if not settings.agent_token or not hmac.compare_digest(authorization.encode(), expected.encode()):
            raise HTTPException(status_code=401, detail="unauthorized")

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "model": settings.openai_model, "configured": bool(settings.openai_api_key and settings.agent_token)}

    @app.exception_handler(OutputRejected)
    async def rejected(_, exc: OutputRejected):  # fail closed: the TypeScript side treats 422 as "model unusable"
        return JSONResponse(status_code=422, content={"error": "model_output_rejected", "message": str(exc)})

    @app.post("/v1/classify-intent", dependencies=[Depends(auth)])
    def classify(req: IntentRequest, a: ConversationAgent = Depends(get_agent)) -> dict:
        data, usage = a.classify_intent(req)
        return {"data": data.model_dump(exclude_none=True), "usage": usage.model_dump(exclude_none=True)}

    @app.post("/v1/extract-card", dependencies=[Depends(auth)])
    def card(req: ImageRequest, a: ConversationAgent = Depends(get_agent)) -> dict:
        try:
            image = base64.b64decode(req.imageBase64, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=400, detail="invalid base64")
        if not image or len(image) > settings.max_image_bytes:
            raise HTTPException(status_code=413, detail="image too large")
        data, usage = a.extract_card(image, req.mimeType)
        return {"data": data.model_dump(exclude_none=True), "usage": usage.model_dump(exclude_none=True)}

    @app.post("/v1/transcribe", dependencies=[Depends(auth)])
    def transcribe(req: AudioRequest, a: ConversationAgent = Depends(get_agent)) -> dict:
        try:
            audio = base64.b64decode(req.audioBase64, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=400, detail="invalid base64")
        if not audio or len(audio) > settings.max_audio_bytes:
            raise HTTPException(status_code=413, detail="audio too large")
        text, duration, usage = a.transcribe(audio, req.mimeType)
        return {"text": text, "durationSec": duration, "usage": usage.model_dump(exclude_none=True)}

    @app.post("/v1/extract-email", dependencies=[Depends(auth)])
    def email(req: TextRequest, a: ConversationAgent = Depends(get_agent)) -> dict:
        data, usage = a.extract_email(req.text)
        return {"data": data.model_dump(exclude_none=True), "usage": usage.model_dump(exclude_none=True)}

    return app


app = create_app()
