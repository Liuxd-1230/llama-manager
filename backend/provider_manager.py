"""External chat provider metadata and environment-key resolution."""
from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from .env_manager import APP_DATA_DIR, env_source, env_value, set_user_env


ProviderKind = Literal["deepseek", "openai_chat", "openai_responses", "anthropic", "openai_compatible"]
SECRETS_DIR = APP_DATA_DIR / "secrets"
PROVIDERS_PATH = SECRETS_DIR / "providers.json"
STANDARD_ENV = {
    "deepseek": "DEEPSEEK_API_KEY",
    "openai_chat": "OPENAI_API_KEY",
    "openai_responses": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}
_MIGRATION_ERRORS: set[str] = set()


class ProviderConfig(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:12])
    name: str = "DeepSeek"
    kind: ProviderKind = "deepseek"
    base_url: str = "https://api.deepseek.com"
    default_model: str = "deepseek-chat"
    models: list[str] = Field(default_factory=list)
    enabled: bool = True


def _default_provider() -> ProviderConfig:
    return ProviderConfig(
        id="deepseek",
        name="DeepSeek",
        kind="deepseek",
        base_url="https://api.deepseek.com",
        default_model="deepseek-chat",
        models=["deepseek-chat", "deepseek-reasoner"],
    )


def provider_specific_env(provider_id: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9]+", "_", provider_id).strip("_").upper() or "CUSTOM"
    return f"LLAMA_MANAGER_PROVIDER_{safe}_API_KEY"


def provider_env_names(provider: ProviderConfig) -> list[str]:
    specific = provider_specific_env(provider.id)
    standard = STANDARD_ENV.get(provider.kind)
    if provider.id == "deepseek" and standard:
        return [standard, specific]
    return [specific, *([standard] if standard else [])]


def resolve_api_key(provider: ProviderConfig) -> str:
    for name in provider_env_names(provider):
        value = env_value(name)
        if value:
            return value
    return ""


def _write_raw(items: list[dict]) -> None:
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    temp = PROVIDERS_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")
    temp.replace(PROVIDERS_PATH)


def _migrate_legacy_keys(items: list[dict]) -> list[dict]:
    _MIGRATION_ERRORS.clear()
    changed = False
    migrated = []
    for raw in items:
        item = dict(raw)
        key = str(item.pop("api_key", "") or "").strip()
        if key:
            provider = ProviderConfig(**item)
            env_name = provider_env_names(provider)[0]
            try:
                set_user_env(env_name, key)
                changed = True
            except Exception:
                _MIGRATION_ERRORS.add(provider.id)
        migrated.append(item)
    # Keep the original JSON untouched if any key could not be secured.
    if changed and not _MIGRATION_ERRORS:
        _write_raw(migrated)
    return migrated


def _read_raw() -> list[dict]:
    if not PROVIDERS_PATH.exists():
        return []
    payload = json.loads(PROVIDERS_PATH.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError("providers.json must contain a list")
    return _migrate_legacy_keys(payload)


def _public(provider: ProviderConfig) -> dict:
    item = provider.model_dump()
    env_names = provider_env_names(provider)
    active_env = next((name for name in env_names if env_value(name)), "")
    item.update({
        "api_key_env": env_names[0],
        "api_key_set": bool(active_env),
        "api_key_source": env_source(active_env) if active_env else "",
    })
    if provider.id in _MIGRATION_ERRORS:
        item["enabled"] = False
        item["api_key_set"] = False
        item["api_key_source"] = ""
        item["migration_error"] = "旧 API Key 迁移失败，请修复 ~/llama-manager/.env 权限后重试"
    if item["default_model"] and item["default_model"] not in item["models"]:
        item["models"] = [item["default_model"], *item["models"]]
    return item


def list_providers(include_keys: bool = False) -> list[dict]:
    # include_keys is retained for call-site compatibility; keys are never returned.
    raw_providers = [ProviderConfig(**item) for item in _read_raw()]
    raw_ids = {provider.id for provider in raw_providers}
    all_providers = ([] if "deepseek" in raw_ids else [_default_provider()]) + raw_providers
    seen: set[str] = set()
    result = []
    for provider in all_providers:
        if provider.id in seen:
            continue
        seen.add(provider.id)
        result.append(_public(provider))
    return result


def get_provider(provider_id: str) -> ProviderConfig | None:
    for item in list_providers():
        if item["id"] == provider_id:
            clean = {key: value for key, value in item.items() if key in ProviderConfig.model_fields}
            return ProviderConfig(**clean)
    return None


def save_provider(data: dict) -> dict:
    if str(data.get("api_key") or "").strip():
        raise ValueError("API keys must be configured through environment variables")
    clean = {key: value for key, value in data.items() if key in ProviderConfig.model_fields}
    provider = ProviderConfig(**clean)
    raw = [item for item in _read_raw() if item.get("id") != provider.id]
    raw.append(provider.model_dump())
    _write_raw(raw)
    return _public(provider)


def delete_provider(provider_id: str) -> bool:
    if provider_id == "deepseek":
        return False
    raw = _read_raw()
    new_raw = [item for item in raw if item.get("id") != provider_id]
    if len(new_raw) == len(raw):
        return False
    _write_raw(new_raw)
    return True
