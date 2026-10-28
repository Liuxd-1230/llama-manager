"""Bridge moss LLM calls to llama-manager's shared provider store.

Credentials never live in moss settings: base_url and key resolve from
providers.json plus the environment, mirroring backend.main's helpers.
The local engine ("local") is a synthetic provider: llama-server already
speaks the OpenAI protocol at its own port and needs no key.
"""

from __future__ import annotations

import os
from types import SimpleNamespace
from typing import Any

from .. import provider_manager
from .config import load_settings


class ProviderError(RuntimeError):
    pass


LOCAL_PROVIDER_ID = "local"


def local_provider() -> SimpleNamespace:
    """The managed llama-server seen as one more provider."""
    from .. import config_manager
    from ..process_manager import process_manager

    config = config_manager.get_config()
    state = process_manager.get_status().state
    host = config.server.host if config.server.host not in ("", "0.0.0.0") else "127.0.0.1"
    path = (config.model_path or "").strip()
    model = path.replace("\\", "/").rsplit("/", 1)[-1] if path else ""
    suffix = "" if state == "running" else "（未运行）"
    return SimpleNamespace(
        id=LOCAL_PROVIDER_ID,
        name=f"本地引擎{suffix}",
        kind="local",
        base_url=f"http://{host}:{config.server.port}",
        default_model=model,
        models=[model] if model else [],
        enabled=True,
    )


def _api_key(provider) -> str:
    return provider_manager.resolve_api_key(provider)


def _openai_base(provider) -> str:
    base = (provider.base_url or "").rstrip("/")
    if not base:
        raise ProviderError(f"提供商 {provider.name} 未配置 base_url")
    if base.rstrip("/") == "https://api.deepseek.com":
        return base
    if not base.endswith("/v1"):
        base = base + "/v1"
    return base


def resolve(provider_id: str | None = None) -> dict[str, Any]:
    if provider_id == LOCAL_PROVIDER_ID:
        provider = local_provider()
        # llama-server exposes /v1/chat/completions and /v1/models; no auth.
        return {"provider": provider, "base_url": provider.base_url + "/v1", "api_key": ""}
    provider = provider_manager.get_provider(provider_id) if provider_id else None
    if provider_id and provider is None:
        raise ProviderError('所选提供商已被移除，请重新选择模型服务')
    if provider is not None and not provider.enabled:
        raise ProviderError('所选提供商已停用，请启用或重新选择模型服务')
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
