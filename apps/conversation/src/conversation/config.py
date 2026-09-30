from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = (
        "postgresql+psycopg://conversation_app:conversation_app@localhost:5433/conversation"
    )
    redis_url: str = "redis://localhost:6380/0"
    queue_backend: str = "memory"
    operator_token: str = ""
    webhook_shared_secret: str = ""
    webhook_max_skew_seconds: int = 300
    twenty_base_url: str = "http://localhost:3000"
    confirmation_ttl_minutes: int = 30
    app_env: str = "development"
    worker_max_attempts: int = 5
    session_window_hours: int = 24

    # Meta WhatsApp Cloud API. Empty values fail closed and never call Graph.
    whatsapp_verify_token: str = ""
    whatsapp_app_secret: str = ""
    whatsapp_access_token: str = ""
    whatsapp_phone_number_id: str = ""
    whatsapp_graph_version: str = "v26.0"
    whatsapp_template_name: str = ""
    whatsapp_template_language: str = "en"

    # Teams bot. JWT is required once TEAMS_APP_ID is set. Otherwise only a configured
    # shared secret is accepted. Unsigned traffic is always rejected.
    teams_app_id: str = ""
    teams_app_password: str = ""
    teams_tenant_id: str = ""
    teams_shared_secret: str = ""

    extraction_provider: str = "fixture"
    extraction_http_url: str = ""
