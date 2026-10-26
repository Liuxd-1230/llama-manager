"""OpenAI 兼容接口：普通调用、流式调用（含 function calling）、模型后备链。"""

from __future__ import annotations

import json
import re
from typing import Any, AsyncIterator, Optional

import httpx
from fastapi import HTTPException

from .config import load_settings, model_chain


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
    if not resolved["api_key"] and getattr(resolved["provider"], "kind", "") != "local":
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
    base, key = _creds()
    s = load_settings()
    last: Optional[Exception] = None
    for m in model_chain(s, model):
        payload = {"model": m, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                r = await client.post(f"{base}/chat/completions", json=payload,
                                      headers={"Authorization": f"Bearer {key}"} if key else {})
            if r.status_code >= 400:
                last = UpstreamError(r.status_code, r.text)
                if r.status_code in (408, 429) or r.status_code >= 500:
                    continue
                raise HTTPException(status_code=502, detail=str(last))
            data = r.json()
            return data["choices"][0]["message"]["content"] or ""
        except httpx.RequestError as e:
            last = e
            continue
        except (KeyError, IndexError, TypeError) as e:
            raise HTTPException(status_code=502, detail=f"上游返回格式异常: {e}") from e
    raise HTTPException(status_code=502, detail=f"所有模型都调用失败：{last}")


async def stream_chat(
    messages: list[dict],
    *,
    tools: Optional[list[dict]] = None,
    model: Optional[str] = None,
    temperature: Optional[float] = None,
    max_tokens: int = 8192,
) -> AsyncIterator[tuple[str, Any]]:
    """
    流式调用。依次产出：
      ("model", name)                开始使用的模型
      ("text", delta)                文本增量
      ("tool_delta", {index, name})  工具调用开始（参数还在流）
      ("done", {"content", "tool_calls": [{id, name, arguments}], "finish_reason"})
    在收到第一个分片之前失败（网络 / 429 / 5xx）会换后备模型重试。
    """
    base, key = _creds()
    s = load_settings()
    temp = s.get("temperature", 0.7) if temperature is None else temperature
    last: Optional[Exception] = None
    for m in model_chain(s, model):
        payload: dict[str, Any] = {
            "model": m, "messages": messages, "temperature": temp,
            "max_tokens": max_tokens, "stream": True,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        started = False
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=20.0)) as client:
                async with client.stream("POST", f"{base}/chat/completions", json=payload,
                                         headers=({"Authorization": f"Bearer {key}"} if key else {})
                                         | {"Accept": "text/event-stream"}) as r:
                    if r.status_code >= 400:
                        body = (await r.aread()).decode("utf-8", "replace")
                        if tools and r.status_code in (400, 404, 422) and _TOOL_ERR.search(body):
                            raise ToolsUnsupported(r.status_code, body)
                        err = UpstreamError(r.status_code, body)
                        if r.status_code in (408, 429) or r.status_code >= 500:
                            last = err
                            continue
                        raise err
                    yield ("model", m)
                    content: list[str] = []
                    calls: dict[int, dict] = {}
                    finish = None
                    ctype = r.headers.get("content-type", "")
                    if "event-stream" not in ctype:
                        # 有些代理忽略 stream=true，直接回完整 JSON
                        data = json.loads((await r.aread()).decode("utf-8"))
                        msg = data["choices"][0]["message"]
                        if msg.get("content"):
                            yield ("text", msg["content"])
                            content.append(msg["content"])
                        for i, tc in enumerate(msg.get("tool_calls") or []):
                            fn = tc.get("function") or {}
                            calls[i] = {"id": tc.get("id") or f"call_{i}", "name": fn.get("name") or "",
                                        "arguments": fn.get("arguments") or "{}"}
                        finish = data["choices"][0].get("finish_reason")
                    else:
                        async for line in r.aiter_lines():
                            line = line.strip()
                            if not line.startswith("data:"):
                                continue
                            raw = line[5:].strip()
                            if raw == "[DONE]":
                                break
                            try:
                                chunk = json.loads(raw)
                            except json.JSONDecodeError:
                                continue
                            if chunk.get("error"):
                                raise UpstreamError(500, json.dumps(chunk["error"], ensure_ascii=False))
                            for ch in chunk.get("choices") or []:
                                started = True
                                delta = ch.get("delta") or {}
                                if delta.get("content"):
                                    content.append(delta["content"])
                                    yield ("text", delta["content"])
                                for tc in delta.get("tool_calls") or []:
                                    idx = tc.get("index", len(calls))
                                    cur = calls.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                                    if tc.get("id"):
                                        cur["id"] = tc["id"]
                                    fn = tc.get("function") or {}
                                    if fn.get("name"):
                                        first = not cur["name"]
                                        cur["name"] += fn["name"]
                                        if first:
                                            yield ("tool_delta", {"index": idx, "name": cur["name"]})
                                    if fn.get("arguments"):
                                        cur["arguments"] += fn["arguments"]
                                if ch.get("finish_reason"):
                                    finish = ch["finish_reason"]
                    tool_calls = []
                    for i in sorted(calls):
                        c = calls[i]
                        if not c["name"]:
                            continue
                        tool_calls.append({"id": c["id"] or f"call_{i}", "name": c["name"],
                                           "arguments": c["arguments"] or "{}"})
                    yield ("done", {"content": "".join(content), "tool_calls": tool_calls,
                                    "finish_reason": finish})
                    return
        except ToolsUnsupported:
            raise
        except httpx.RequestError as e:
            if started:
                raise UpstreamError(0, f"流式连接中断：{e}") from e
            last = e
            continue
    raise UpstreamError(0, f"所有模型都调用失败：{last}")
