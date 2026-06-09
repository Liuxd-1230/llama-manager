"""External chat provider configuration storage."""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field


ProviderKind = Literal["deepseek", "openai_chat", "openai_responses", "anthropic", "openai_compatible"]

SECRETS_DIR = Path.home() / "llama-manager" / "secrets"
PROVIDERS_PATH = SECRETS_DIR / "providers.json"


class ProviderConfig(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    name: str = "DeepSeek"
    kind: ProviderKind = "deepseek"
    base_url: str = "https://api.deepseek.com"
    api_key: str = ""
    default_model: str = "deepseek-v4-flash"
    models: list[str] = Field(default_factory=list)
    enabled: bool = True


def _default_provider() -> ProviderConfig:
    return ProviderConfig(
        id="deepseek",
        name="DeepSeek",
        kind="deepseek",
        base_url="https://api.deepseek.com",
        api_key=os.getenv("DEEPSEEK_API_KEY", "").strip(),
        default_model="deepseek-v4-flash",
        models=["deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    )


def _read_raw() -> list[dict]:
    if not PROVIDERS_PATH.exists():
        return []
    return json.loads(PROVIDERS_PATH.read_text(encoding="utf-8"))


def _write_raw(items: list[dict]) -> None:
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    PROVIDERS_PATH.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")


def list_providers(include_keys: bool = False) -> list[dict]:
    raw_providers = [ProviderConfig(**item) for item in _read_raw()]
    raw_ids = {provider.id for provider in raw_providers}
    providers = ([] if "deepseek" in raw_ids else [_default_provider()]) + raw_providers
    seen: set[str] = set()
    result = []
    for provider in providers:
        if provider.id in seen:
            continue
        seen.add(provider.id)
        item = provider.model_dump()
        if not include_keys:
            item["api_key_set"] = bool(item.get("api_key"))
            item["api_key"] = ""
        return_model = item.get("default_model")
        if return_model and return_model not in item.get("models", []):
            item["models"] = [return_model, *item.get("models", [])]
        result.append(item)
    return result


def get_provider(provider_id: str) -> ProviderConfig | None:
    for item in list_providers(include_keys=True):
        if item["id"] == provider_id:
            return ProviderConfig(**item)
    return None


def save_provider(data: dict) -> dict:
    existing = get_provider(data.get("id", "")) if data.get("id") else None
    if existing and not data.get("api_key"):
        data["api_key"] = existing.api_key
    provider = ProviderConfig(**data)
    raw = [item for item in _read_raw() if item.get("id") != provider.id]
    raw.append(provider.model_dump())
    _write_raw(raw)
    public = provider.model_dump()
    public["api_key_set"] = bool(public.get("api_key"))
    public["api_key"] = ""
    return public


def delete_provider(provider_id: str) -> bool:
    if provider_id == "deepseek":
        return False
    raw = _read_raw()
    new_raw = [item for item in raw if item.get("id") != provider_id]
    if len(new_raw) == len(raw):
        return False
    _write_raw(new_raw)
    return True
