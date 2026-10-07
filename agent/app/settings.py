from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-4o-mini"
    openai_vision_model: str = "gpt-4o-mini"
    openai_stt_model: str = "whisper-1"
    # Shared secret between the TypeScript API/worker and this service (internal network only).
    agent_token: str = ""
    max_text_chars: int = 4000
    max_image_bytes: int = 10 * 1024 * 1024
    max_audio_bytes: int = 20 * 1024 * 1024
    llm_timeout_s: float = 25.0


@lru_cache
def get_settings() -> Settings:
    return Settings()
