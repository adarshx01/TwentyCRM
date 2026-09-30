from __future__ import annotations

import hmac
import json
import uuid
from contextlib import contextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from conversation.admin.schemas import (
    CancelBody,
    ConfirmBody,
    CreateMembershipBody,
    CreateTenantBody,
    EditBody,
    EnrollmentBody,
    IntakeSourceBody,
    RedeemBody,
    RevokeBody,
)
from conversation.channels.teams import IgnoredActivity, is_activity, legacy_envelope, parse_teams_activity
from conversation.channels.whatsapp import parse_whatsapp_payload
from conversation.config import Settings
from conversation.errors import DomainError
from conversation.health import build_health
from conversation.runtime import AppDeps, RequestServices, build_deps, open_services
from conversation.security import require_operator, verify_hmac_signature, verify_meta_signature


def create_app(deps: AppDeps | None = None) -> FastAPI:
    deps = deps or build_deps(Settings())
    app = FastAPI(title="Conversational CRM", version="0.1.0")
    app.state.deps = deps

    @app.exception_handler(DomainError)
    async def domain_error(_request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(status_code=exc.http_status, content={"error": exc.code, "message": str(exc)})

    @app.get("/health")
    def health() -> JSONResponse:
        code, report = build_health(deps)
        return JSONResponse(status_code=code, content=report)

    @app.get("/webhooks/whatsapp")
    def whatsapp_verify(request: Request) -> PlainTextResponse:
        mode = _query(request, "hub.mode")
        token = _query(request, "hub.verify_token")
        challenge = _query(request, "hub.challenge")
        expected = deps.settings.whatsapp_verify_token
        if mode != "subscribe" or not expected or not token or challenge is None:
            raise DomainError("unauthorized", "whatsapp verify token rejected", 403)
        try:
            matches = hmac.compare_digest(token, expected)
        except (TypeError, ValueError):
            matches = False
        if not matches:
            raise DomainError("unauthorized", "whatsapp verify token rejected", 403)
        return PlainTextResponse(challenge)

    @app.post("/webhooks/whatsapp")
    async def whatsapp(request: Request) -> dict:
        raw = await request.body()
        payload = _json_body(raw)
        signature = request.headers.get("x-hub-signature-256")
        meta = bool(signature) or (
            isinstance(payload, dict) and payload.get("object") == "whatsapp_business_account"
        )
        if meta:
            verify_meta_signature(
                secret=deps.settings.whatsapp_app_secret,
                signature=signature,
                raw_body=raw,
            )
            if not isinstance(payload, dict):
                raise DomainError("invalid_body", "webhook body is not json")
            events = parse_whatsapp_payload(payload)
            if not events:
                return {"status": "ignored"}
            with _scope() as services:
                results = [services.worker.accept(event) for event in events]
            if len(results) == 1:
                return {"status": results[0]}
            return {"status": "accepted", "results": results}
        _verify_shared(request, raw, deps.settings.webhook_shared_secret)
        event = legacy_envelope(payload if isinstance(payload, dict) else {}, "whatsapp")
        if not event.external_user_id or not event.message_id:
            raise DomainError("invalid_body", "external_user_id and message_id are required")
        with _scope() as services:
            return {"status": services.worker.accept(event)}

    @app.post("/webhooks/teams")
    async def teams(request: Request) -> dict:
        raw = await request.body()
        payload = _json_body(raw)
        if not isinstance(payload, dict):
            raise DomainError("invalid_body", "webhook body is not json")
        _authorize_teams(request, raw, payload)
        if is_activity(payload):
            try:
                event = parse_teams_activity(payload)
            except IgnoredActivity as exc:
                return {"status": "ignored", "reason": exc.reason}
        else:
            event = legacy_envelope(payload, "teams")
        if not event.external_user_id or not event.message_id:
            raise DomainError("invalid_body", "external_user_id and message_id are required")
        with _scope() as services:
            return {"status": services.worker.accept(event)}

    @app.post("/admin/tenants")
    def create_tenant(body: CreateTenantBody, request: Request) -> dict:
        _operator(request)
        with _scope() as services:
            tenant = services.tenancy.create_tenant(
                name=body.name,
                deployment_id=body.deployment_id,
                twenty_workspace_id=body.twenty_workspace_id,
                twenty_base_url=body.twenty_base_url,
                twenty_api_key_ref=body.twenty_api_key_ref,
                manifest_version=body.manifest_version,
                daily_draft_quota=body.daily_draft_quota,
            )
            return {
                "id": str(tenant.id),
                "manifest_version": tenant.manifest_version,
                "twenty_api_key_ref": tenant.twenty_api_key_ref,
            }

    @app.post("/admin/tenants/{tenant_id}/memberships")
    def create_membership(tenant_id: uuid.UUID, body: CreateMembershipBody, request: Request) -> dict:
        _operator(request)
        with _scope() as services:
            membership = services.identity.add_membership(
                tenant_id,
                display_name=body.display_name,
                role=body.role,
                channel=body.channel,
                external_id=body.external_id,
            )
            return {"id": str(membership.id), "role": membership.role, "status": membership.status}

    @app.post("/admin/tenants/{tenant_id}/enrollment-codes")
    def enrollment(tenant_id: uuid.UUID, body: EnrollmentBody, request: Request) -> dict:
        _operator(request)
        with _scope() as services:
            code = services.identity.issue_enrollment_code(tenant_id, role=body.role)
            return {"code": code}

    @app.post("/admin/enrollment-codes/redeem")
    def redeem(body: RedeemBody) -> dict:
        with _scope() as services:
            membership = services.identity.redeem_enrollment_code(
                code=body.code,
                display_name=body.display_name,
                channel=body.channel,
                external_id=body.external_id,
            )
            return {"membership_id": str(membership.id), "tenant_id": str(membership.tenant_id)}

    @app.post("/admin/tenants/{tenant_id}/memberships/{membership_id}/revoke")
    def revoke(
        tenant_id: uuid.UUID,
        membership_id: uuid.UUID,
        body: RevokeBody,
        request: Request,
    ) -> dict:
        _operator(request)
        with _scope() as services:
            target = services.identity.revoke(tenant_id, membership_id, uuid.UUID(body.actor_membership_id))
            return {"id": str(target.id), "status": target.status}

    @app.post("/admin/tenants/{tenant_id}/intake-sources")
    def intake_source(tenant_id: uuid.UUID, body: IntakeSourceBody, request: Request) -> dict:
        _operator(request)
        with _scope() as services:
            source = services.intake.add_source(
                tenant_id,
                alias=body.alias,
                mode=body.mode,
                actor_membership_id=uuid.UUID(body.actor_membership_id),
            )
            return {"id": str(source.id), "alias": source.alias, "mode": source.mode}

    @app.post("/intake/email")
    async def intake_email(request: Request) -> dict:
        raw = await _signed_text(request)
        with _scope() as services:
            result = services.intake.receive(raw)
            return _intake_body(result)

    @app.post("/intake/forms/{source_id}")
    async def intake_form(source_id: uuid.UUID, request: Request) -> dict:
        raw_bytes = await request.body()
        _verify_shared(request, raw_bytes, deps.settings.webhook_shared_secret)
        content_type = request.headers.get("content-type", "")
        if "application/json" in content_type:
            payload = _json_body(raw_bytes)
            if not isinstance(payload, dict):
                raise DomainError("invalid_body", "intake body is not json")
            message_id = str(payload.get("message_id") or "")
            body = str(payload.get("body") or "")
            if not message_id:
                raise DomainError("invalid_intake", "message_id is required")
            raw = f"Message-Id: <{message_id}>\n\n{body}"
        else:
            raw = raw_bytes.decode("utf-8")
        with _scope() as services:
            result = services.intake.receive(raw, source_id=source_id)
            return _intake_body(result)

    @app.get("/drafts/{draft_id}")
    def preview_draft(draft_id: uuid.UUID, channel: str, external_user_id: str) -> dict:
        with _scope() as services:
            binding = _binding(services, channel, external_user_id)
            draft = services.drafts.get(binding.tenant_id, draft_id)
            return {
                "id": str(draft.id),
                "state": draft.state,
                "version": draft.version,
                "content_hash": draft.content_hash,
                "payload": draft.payload,
                "expires_at": draft.expires_at.isoformat() if draft.expires_at else None,
            }

    @app.post("/drafts/{draft_id}/confirm")
    def confirm(draft_id: uuid.UUID, body: ConfirmBody) -> dict:
        with _scope() as services:
            binding = _binding(services, body.channel, body.external_user_id)
            tenant = services.tenancy.get(binding.tenant_id)
            operation = services.drafts.confirm(
                binding.tenant_id,
                draft_id,
                actor_membership_id=binding.membership_id,
                version=body.version,
                content_hash_value=body.content_hash,
                client=services.crm_for(tenant),
            )
            return {"operation_id": str(operation.id), "status": operation.status}

    @app.post("/drafts/{draft_id}/edit")
    def edit(draft_id: uuid.UUID, body: EditBody) -> dict:
        with _scope() as services:
            binding = _binding(services, body.channel, body.external_user_id)
            draft = services.drafts.edit(
                binding.tenant_id,
                draft_id,
                actor_membership_id=binding.membership_id,
                card=body.card,
            )
            return {
                "id": str(draft.id),
                "state": draft.state,
                "version": draft.version,
                "content_hash": draft.content_hash,
            }

    @app.post("/drafts/{draft_id}/cancel")
    def cancel(draft_id: uuid.UUID, body: CancelBody) -> dict:
        with _scope() as services:
            binding = _binding(services, body.channel, body.external_user_id)
            draft = services.drafts.cancel(
                binding.tenant_id,
                draft_id,
                actor_membership_id=binding.membership_id,
            )
            return {"id": str(draft.id), "state": draft.state}

    @app.post("/internal/queue/drain")
    def drain(request: Request) -> dict:
        _operator(request)
        with _scope() as services:
            results = services.worker.drain()
            return {"results": results}

    def _authorize_teams(request: Request, raw: bytes, payload: dict) -> None:
        authorization = request.headers.get("authorization") or ""
        if deps.settings.teams_app_id:
            if not authorization.lower().startswith("bearer "):
                raise DomainError("unauthorized", "teams bearer token required", 401)
            token = authorization.split(" ", 1)[1].strip()
            verifier = deps.teams_verifier
            if verifier is None:
                raise DomainError("unauthorized", "teams verifier is not configured", 401)
            verifier.verify(
                token,
                service_url=str(payload.get("serviceUrl") or ""),
                channel_id=str(payload.get("channelId") or ""),
            )
            return
        secret = deps.settings.teams_shared_secret or deps.settings.webhook_shared_secret
        if not secret:
            raise DomainError("unauthorized", "teams credentials are not configured", 401)
        _verify_shared(request, raw, secret)

    async def _signed_text(request: Request) -> str:
        raw = await request.body()
        _verify_shared(request, raw, deps.settings.webhook_shared_secret)
        return raw.decode("utf-8")

    def _verify_shared(request: Request, raw: bytes, secret: str) -> None:
        verify_hmac_signature(
            secret=secret,
            timestamp=request.headers.get("x-conversation-timestamp"),
            signature=request.headers.get("x-conversation-signature"),
            raw_body=raw,
            now_epoch=int(deps.clock.now().timestamp()),
            max_skew_seconds=deps.settings.webhook_max_skew_seconds,
        )

    def _operator(request: Request) -> None:
        require_operator(deps.settings.operator_token, request.headers.get("authorization"))

    @contextmanager
    def _scope():
        services: RequestServices = open_services(deps)
        try:
            yield services
            services.session.commit()
        except Exception:
            services.session.rollback()
            raise
        finally:
            services.session.close()

    return app


def _query(request: Request, name: str) -> str | None:
    return request.query_params.get(name) or request.query_params.get(name.replace(".", "_"))


def _json_body(raw: bytes) -> object:
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DomainError("invalid_body", "webhook body is not json") from exc


def _binding(services: RequestServices, channel: str, external_user_id: str):
    binding = services.identity.resolve_binding(channel, external_user_id)
    if binding is None:
        raise DomainError("forbidden", "channel binding is not active", 403)
    return binding


def _intake_body(result) -> dict:
    return {
        "route": result.route,
        "duplicate": result.duplicate,
        "tenant_id": str(result.tenant_id) if result.tenant_id else None,
        "draft_id": str(result.draft_id) if result.draft_id else None,
    }


app = create_app()
