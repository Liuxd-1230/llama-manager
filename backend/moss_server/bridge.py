"""Bridge moss LLM calls to llama-manager's shared provider store.

Credentials never live in moss settings: base_url and key resolve from
providers.json plus the environment, mirroring backend.main's helpers.
"""

from __future__ import annotations

import os
from typing import Any

from .. import provider_manager
from .config import load_settings


class ProviderError(RuntimeError):
    pass


def _api_key(provider) -> str:
    for name in provider_manager.provider_env_names(provider):
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


def _openai_base(provider) -> str:
    base = (provider.base_url or "").rstrip("/")
    if not base:
        raise ProviderError(f"提供商 {provider.name} 未配置 base_url")
    if provider.kind == "anthropic":
        raise ProviderError("Anthropic 协议不受提示词工坊支持，请改用 OpenAI 兼容提供商")
    if provider.kind == "deepseek" and base == "https://api.deepseek.com":
        return base
    if not base.endswith("/v1"):
        base = base + "/v1"
    return base


def resolve(provider_id: str | None = None) -> dict[str, Any]:
    provider = provider_manager.get_provider(provider_id) if provider_id else None
    if provider is None:
        enabled = [item for item in provider_manager.list_providers() if item.get("enabled")]
        if not enabled:
            raise ProviderError("没有可用的提供商，请先在系统设置中配置")
        provider = provider_manager.get_provider(enabled[0]["id"])
    return {"provider": provider, "base_url": _openai_base(provider), "api_key": _api_key(provider)}


def model_chain(provider_id: str | None, primary: str | None = None) -> list[str]:
    resolved = resolve(provider_id)
    provider = resolved["provider"]
    settings = load_settings()
    first = (primary or settings.get("model") or "").strip() or provider.default_model
    chain = [first]
    for model in [*provider.models, provider.default_model]:
        model = (model or "").strip()
        if model and model not in chain:
            chain.append(model)
    for model in [item.strip() for item in str(settings.get("fallback_models") or "").split(",") if item.strip()]:
        if model not in chain:
            chain.append(model)
    return chain
