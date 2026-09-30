from pydantic import BaseModel, ConfigDict, Field, field_validator


class CreateTenantBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    deployment_id: str
    twenty_workspace_id: str
    twenty_base_url: str
    twenty_api_key_ref: str
    manifest_version: str = "2026.1"
    daily_draft_quota: int | None = None

    @field_validator("twenty_api_key_ref")
    @classmethod
    def reference_only(cls, value: str) -> str:
        if not (value.startswith("secret://") or value.startswith("env://")):
            raise ValueError("twenty_api_key_ref must be a secret:// or env:// reference")
        return value


class CreateMembershipBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str
    role: str
    channel: str | None = None
    external_id: str | None = None


class EnrollmentBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: str


class RedeemBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    display_name: str
    channel: str
    external_id: str


class RevokeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    actor_membership_id: str = Field(description="Client admin performing the revocation")


class ConfirmBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int
    content_hash: str
    channel: str
    external_user_id: str


class EditBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel: str
    external_user_id: str
    card: dict


class CancelBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel: str
    external_user_id: str


class IntakeSourceBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    alias: str
    mode: str
    actor_membership_id: str
