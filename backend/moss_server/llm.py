"""OpenAI 兼容接口：普通调用、流式调用（含 function calling）、模型后备链。"""

from __future__ import annotations

import json
import re
from typing import Any, AsyncIterator, Optional

import httpx
from fastapi import HTTPException

from .config import load_settings


class UpstreamError(Exception):
    def __init__(self, status: int, text: str):
        super().__init__(f"上游 API 错误 {status}: {text[:500]}")
        self.status = status
        self.text = text


class ToolsUnsupported(UpstreamError):
    pass


_TOOL_ERR = re.compile(r"tool|function", re.I)


def _creds() -> tuple[str, str]:
    from .bridge import resolve, ProviderError

    s = load_settings()
    try:
        resolved = resolve(s.get("provider_id"))
    except ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    from ..provider_manager import requires_api_key
    if not resolved["api_key"] and getattr(resolved["provider"], "kind", "") != "local" and requires_api_key(resolved["provider"]):
        raise HTTPException(status_code=400, detail=f"提供商 {resolved['provider'].name} 未配置密钥：请在系统设置中设置对应的环境变量。")
    return resolved["base_url"], resolved["api_key"]


def extract_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            return json.loads(m.group(0))
        raise


async def chat(messages: list[dict], *, model: Optional[str] = None, max_tokens: int = 4096,
               temperature: float = 0.7) -> str:
    """非流式调用（反推、摘要等）。"""
    from ..atelier.providers import complete
    message = await complete(messages, model=model, temperature=temperature, max_tokens=max_tokens)
    return message.get('content') or ''



async def stream_chat(
    messages: list[dict],
    *,
    tools: Optional[list[dict]] = None,
    model: Optional[str] = None,
    temperature: Optional[float] = None,
    max_tokens: int = 8192,
    top_p: Optional[float] = None,
) -> AsyncIterator[tuple[str, Any]]:
    """
    流式调用。依次产出：
      ("model", name)                开始使用的模型
      ("text", delta)                文本增量
      ("tool_delta", {index, name})  工具调用开始（参数还在流）
      ("done", {"content", "tool_calls": [{id, name, arguments}], "finish_reason"})
    在收到第一个分片之前失败（网络 / 429 / 5xx）会换后备模型重试。
    """
    from ..atelier import providers
    s = providers.request_settings()
    primary = (model or s.get('model') or '').strip()
    chain = list(dict.fromkeys([primary, *[x.strip() for x in str(s.get('fallback_models') or '').split(',') if x.strip()]]))
    for index, candidate in enumerate(chain):
        received = False
        try:
            async for kind, value in providers.stream(messages, model=candidate or None,
                    provider_id=s.get('provider_id'), temperature=s.get('temperature', .7) if temperature is None else temperature,
                    max_tokens=max_tokens, tools=tools, top_p=top_p):
                if kind in ('text', 'reasoning', 'tool_delta'): received = True
                yield kind, value
            return
        except providers.ToolsUnsupported as exc:
            raise ToolsUnsupported(exc.status, '模型服务不支持函数调用') from exc
        except (providers.StreamError, httpx.HTTPError) as exc:
            status = getattr(exc, 'status', 0)
            if received or index == len(chain)-1 or status not in (0,408,429) and status < 500:
                raise UpstreamError(status, str(exc)) from exc
