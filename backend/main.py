"""FastAPI main application — routes and WebSocket."""
from __future__ import annotations
import asyncio
import json
import os
from pathlib import Path
import re
import time
import uuid
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from .models import AppConfig
from . import config_manager as cfg
from . import provider_manager as providers
from . import search_manager
from .process_manager import process_manager
from .update_manager import update_manager
from .download_manager import download_manager
from .optimizer import optimizer
from .chat_state import CandidateContext, conversation_store

app = FastAPI(title="llama.cpp Run Manager")

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
_optimizer_task: asyncio.Task | None = None
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEFAULT_BASE_URLS = {
    "deepseek": "https://api.deepseek.com",
    "openai_chat": "https://api.openai.com/v1",
    "openai_responses": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "openai_compatible": "",
}


def _remote_api_enabled() -> bool:
    return os.getenv("LLAMA_MANAGER_ALLOW_REMOTE", "").lower() in {"1", "true", "yes", "on"}


def _is_local_host(host: str | None) -> bool:
    return host in {"127.0.0.1", "::1", "localhost", "testclient"} or (host or "").startswith("127.")


def _chat_completions_url(base_url: str) -> str:
    base = (base_url or DEEPSEEK_BASE_URL).rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def _provider_api_key(provider: providers.ProviderConfig) -> str:
    return providers.resolve_api_key(provider)


def _provider_headers(provider: providers.ProviderConfig) -> dict[str, str]:
    api_key = _provider_api_key(provider)
    if not api_key:
        raise RuntimeError(f"{provider.name} API key is not set")
    if provider.kind == "anthropic":
        return {
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        }
    return {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}


def _provider_base_url(provider: providers.ProviderConfig) -> str:
    base = provider.base_url or DEFAULT_BASE_URLS.get(provider.kind, "")
    if provider.kind == "deepseek" and base.rstrip("/") == "https://api.deepseek.com":
        return "https://api.deepseek.com"
    return base.rstrip("/")


def _provider_models_url(provider: providers.ProviderConfig) -> str:
    base = _provider_base_url(provider)
    if not base:
        raise RuntimeError("Base URL is required")
    if provider.kind == "anthropic":
        return f"{base}/models"
    return f"{base}/models"


async def _search_web(query: str, limit: int = 4) -> list[dict[str, str]]:
    _provider, results = await search_manager.search_web(query, limit)
    return results


def _latest_user_text(messages: list[dict]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            content = message.get("content", "")
            if isinstance(content, str):
                return content[:500]
    return ""


async def _messages_with_search_context(messages: list[dict], enabled: bool) -> list[dict]:
    if not enabled:
        return messages
    query = _latest_user_text(messages)
    try:
        results = await _search_web(query)
    except Exception as exc:
        search_text = f"网页搜索失败：{exc}"
    else:
        if results:
            lines = ["以下是搜索摘要注入返回的公开网页结果。它不是模型可调用工具；请基于这些来源回答，并在相关处引用来源编号。"]
            for idx, item in enumerate(results, 1):
                lines.append(f"[{idx}] {item['title']}\nURL: {item['url']}")
                if item.get("snippet"):
                    lines.append(f"摘要: {item['snippet']}")
            search_text = "\n\n".join(lines)
        else:
            search_text = "网页搜索没有返回可用结果。"
    return [{"role": "system", "content": search_text}, *messages]


async def _messages_with_web_context(messages: list[dict], enabled: bool) -> list[dict]:
    return await _messages_with_search_context(messages, enabled)


def _messages_with_web_tool_guidance(messages: list[dict], enabled: bool) -> list[dict]:
    if not enabled:
        return messages
    guidance = (
        "Web Search is available as the `web_search` tool. For news, latest events, this week, "
        "current, recent, time-sensitive, uncertain, unknown, or external facts, call `web_search` before answering. "
        "Use the search result URLs in the final answer when relevant. If you choose not to call "
        "the tool, answer only when the request does not need current web information. "
        "Do not write DSML, XML, JSON, or pseudo tool-call tags in the visible answer or reasoning; "
        "use native tool_calls only."
    )
    return [{"role": "system", "content": guidance}, *messages]


def _looks_like_missed_web_search(content: str) -> bool:
    text = str(content or "").lower()
    markers = [
        "无法联网",
        "不能联网",
        "无法访问互联网",
        "无法实时",
        "无法获取最新",
        "不能获取最新",
        "不能浏览",
        "无法浏览",
        "知识库",
        "not have access to the internet",
        "cannot access the internet",
        "can't browse",
        "cannot browse",
        "knowledge cutoff",
        "real-time",
        "latest information",
    ]
    return any(marker in text for marker in markers)


def _force_web_search_tool_choice(payload: dict) -> dict:
    forced = dict(payload)
    forced["tool_choice"] = {"type": "function", "function": {"name": "web_search"}}
    return forced


def _local_chat_payload(data: dict, config: AppConfig, messages: list[dict]) -> dict:
    sampling = config.sampling
    web_tool = bool(data.get("web_search_tool") or data.get("web_search") is True)
    payload = {
        "model": data.get("model") or "default",
        "messages": messages,
        "stream": data.get("stream", True),
        "temperature": sampling.temperature,
        "top_k": sampling.top_k,
        "top_p": sampling.top_p,
    }
    if sampling.min_p_enabled:
        payload["min_p"] = sampling.min_p
    if sampling.repeat_penalty_enabled:
        payload["repeat_penalty"] = sampling.repeat_penalty
    if sampling.presence_penalty_enabled:
        payload["presence_penalty"] = sampling.presence_penalty
    if web_tool:
        payload["tools"] = [_web_search_tool_schema()]
        payload["tool_choice"] = "auto"
    return payload


def _deepseek_chat_payload(data: dict, messages: list[dict]) -> dict:
    thinking_enabled = bool(data.get("thinking_enabled"))
    effort = data.get("reasoning_effort") if data.get("reasoning_effort") in {"high", "max"} else "high"
    payload = {
        "model": data.get("model") or "deepseek-v4-flash",
        "messages": messages,
        "stream": data.get("stream", True),
        "thinking": {"type": "enabled" if thinking_enabled else "disabled"},
    }
    if thinking_enabled:
        payload["reasoning_effort"] = effort
    return payload


def _web_search_tool_schema() -> dict:
    return {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the public web when current or external information is needed. Return concise source summaries.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query in the user's language."},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 5, "description": "Number of search results."},
                },
                "required": ["query"],
            },
        },
    }


DSML_BLOCK_RE = re.compile(
    r"<\s*\|\s*DSML\s*\|\s*tool_calls\s*>[\s\S]*?</\s*\|\s*DSML\s*\|\s*tool_calls\s*>",
    re.IGNORECASE,
)
DSML_INVOKE_RE = re.compile(
    r"<\s*\|\s*DSML\s*\|\s*invoke\s+name=[\"']([^\"']+)[\"']\s*>([\s\S]*?)</\s*\|\s*DSML\s*\|\s*invoke\s*>",
    re.IGNORECASE,
)
DSML_PARAMETER_RE = re.compile(
    r"<\s*\|\s*DSML\s*\|\s*parameter\s+name=[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)</\s*\|\s*DSML\s*\|\s*parameter\s*>",
    re.IGNORECASE,
)


def _strip_dsml_tool_blocks(text: str) -> str:
    return DSML_BLOCK_RE.sub("", str(text or "")).strip()


def _parse_dsml_tool_calls(text: str) -> list[dict]:
    calls = []
    for block in DSML_BLOCK_RE.findall(str(text or "")):
        for call_index, match in enumerate(DSML_INVOKE_RE.finditer(block), 1):
            name = match.group(1).strip()
            args = {}
            for param_name, param_value in DSML_PARAMETER_RE.findall(match.group(2)):
                value = param_value.strip()
                if param_name == "limit":
                    try:
                        args[param_name] = int(value)
                    except ValueError:
                        args[param_name] = value
                else:
                    args[param_name] = value
            calls.append({
                "id": f"dsml_{len(calls) + call_index}",
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
            })
    return calls


def _anthropic_web_search_tool_schema() -> dict:
    fn = _web_search_tool_schema()["function"]
    return {"name": fn["name"], "description": fn["description"], "input_schema": fn["parameters"]}


async def _run_web_search_tool(arguments: dict) -> str:
    query = " ".join(str(arguments.get("query", "")).split())
    limit = int(arguments.get("limit") or 4)
    provider, results = await search_manager.search_web(query, limit=max(1, min(limit, 5)))
    if not results:
        return "No web results found."
    lines = [f"Search provider: {provider}"]
    for idx, item in enumerate(results, 1):
        lines.append(f"[{idx}] {item['title']}\nURL: {item['url']}")
        if item.get("snippet"):
            lines.append(f"Summary: {item['snippet']}")
    return "\n\n".join(lines)


def _external_chat_request(provider: providers.ProviderConfig, data: dict, messages: list[dict]) -> tuple[str, dict]:
    base = _provider_base_url(provider)
    model = data.get("model") or provider.default_model
    web_tool = bool(data.get("web_search_tool") or data.get("web_search") is True)
    if provider.kind == "openai_responses":
        payload = {
            "model": model,
            "input": [{"role": m.get("role", "user"), "content": m.get("content", "")} for m in messages],
            "stream": data.get("stream", True),
        }
        if web_tool:
            payload["tools"] = [{
                "type": "function",
                "name": "web_search",
                "description": _web_search_tool_schema()["function"]["description"],
                "parameters": _web_search_tool_schema()["function"]["parameters"],
            }]
        return f"{base}/responses", payload
    if provider.kind == "anthropic":
        system = "\n\n".join(m.get("content", "") for m in messages if m.get("role") == "system")
        chat_messages = [
            {"role": "assistant" if m.get("role") == "assistant" else "user", "content": m.get("content", "")}
            for m in messages
            if m.get("role") != "system"
        ]
        payload = {
            "model": model,
            "messages": chat_messages,
            "max_tokens": int(data.get("max_tokens") or 4096),
            "stream": data.get("stream", True),
        }
        if system:
            payload["system"] = system
        if web_tool:
            payload["tools"] = [_anthropic_web_search_tool_schema()]
        return f"{base}/messages", payload
    if provider.kind == "deepseek":
        payload = _deepseek_chat_payload(data, messages)
        if web_tool:
            payload["tools"] = [_web_search_tool_schema()]
            payload["tool_choice"] = "auto"
        return _chat_completions_url(base), payload
    payload = {
        "model": model,
        "messages": messages,
        "stream": data.get("stream", True),
    }
    if web_tool:
        payload["tools"] = [_web_search_tool_schema()]
        payload["tool_choice"] = "auto"
    return _chat_completions_url(base), payload


def _openai_chunk(content: str = "", reasoning: str = "") -> str:
    delta = {}
    if content:
        delta["content"] = content
    if reasoning:
        delta["reasoning_content"] = reasoning
    return "data: " + json.dumps({"choices": [{"delta": delta}]}, ensure_ascii=False) + "\n\n"


def _tool_event_chunk(event: dict) -> str:
    return "data: " + json.dumps({"tool_event": event}, ensure_ascii=False) + "\n\n"


def _normalize_external_sse(provider_kind: str, payload: dict) -> str:
    if provider_kind in {"deepseek", "openai_chat", "openai_compatible"}:
        return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
    if provider_kind == "openai_responses":
        event_type = payload.get("type", "")
        if event_type in {"response.output_text.delta", "response.refusal.delta"}:
            return _openai_chunk(content=payload.get("delta", ""))
        if event_type in {"response.reasoning_summary_text.delta", "response.reasoning_text.delta"}:
            return _openai_chunk(reasoning=payload.get("delta", ""))
        return ""
    if provider_kind == "anthropic":
        if payload.get("type") != "content_block_delta":
            return ""
        delta = payload.get("delta", {})
        if delta.get("type") == "text_delta":
            return _openai_chunk(content=delta.get("text", ""))
        if delta.get("type") in {"thinking_delta", "signature_delta"}:
            return _openai_chunk(reasoning=delta.get("thinking", "") or delta.get("signature", ""))
    return ""


def _normalize_non_stream_response(provider_kind: str, payload: dict) -> dict:
    if provider_kind in {"deepseek", "openai_chat", "openai_compatible"}:
        return payload
    content = ""
    reasoning = ""
    if provider_kind == "openai_responses":
        for item in payload.get("output", []):
            for part in item.get("content", []):
                if part.get("type") in {"output_text", "text"}:
                    content += part.get("text", "")
                elif "reasoning" in part.get("type", ""):
                    reasoning += part.get("text", "") or part.get("summary", "")
    elif provider_kind == "anthropic":
        for part in payload.get("content", []):
            if part.get("type") == "text":
                content += part.get("text", "")
            elif "thinking" in part.get("type", ""):
                reasoning += part.get("thinking", "")
    message = {"role": "assistant", "content": content}
    if reasoning:
        message["reasoning_content"] = reasoning
    normalized = {"choices": [{"message": message}], "raw": payload}
    if payload.get("tool_events"):
        normalized["tool_events"] = payload.get("tool_events")
    return normalized


def _tool_summary(text: str, limit: int = 700) -> str:
    text = str(text or "").strip()
    return text if len(text) <= limit else text[:limit].rstrip() + "..."


def _merge_tool_call_delta(acc: dict[int, dict], delta_call: dict) -> None:
    index = int(delta_call.get("index") or 0)
    call = acc.setdefault(index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
    if delta_call.get("id"):
        call["id"] = delta_call.get("id")
    if delta_call.get("type"):
        call["type"] = delta_call.get("type")
    fn = delta_call.get("function") or {}
    if fn.get("name"):
        call["function"]["name"] = fn.get("name")
    if fn.get("arguments"):
        call["function"]["arguments"] += fn.get("arguments")


async def _execute_chat_tool_calls(
    messages: list[dict],
    tool_calls: list[dict],
    assistant_message: dict | None = None,
) -> list[dict]:
    events = []
    if assistant_message is None:
        assistant_message = {"role": "assistant", "content": "", "tool_calls": tool_calls}
    else:
        assistant_message = dict(assistant_message)
        assistant_message["role"] = "assistant"
        assistant_message["tool_calls"] = tool_calls
    messages.append(assistant_message)
    for call in tool_calls:
        fn = call.get("function", {})
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except Exception:
            args = {}
        events.append({"type": "call", "name": fn.get("name") or "", "query": args.get("query") or "", "limit": args.get("limit") or ""})
        if fn.get("name") != "web_search":
            result = f"Unsupported tool: {fn.get('name')}"
        else:
            try:
                result = await _run_web_search_tool(args)
            except Exception as exc:
                result = f"web_search failed: {type(exc).__name__}: {exc}"
        events.append({"type": "result", "name": fn.get("name") or "", "summary": _tool_summary(result)})
        messages.append({"role": "tool", "tool_call_id": call.get("id"), "content": result})
    return events


async def _complete_with_chat_tools(target: str, headers: dict[str, str], payload: dict, max_rounds: int = 4) -> dict:
    import httpx
    tool_payload = dict(payload)
    tool_payload["stream"] = False
    tool_events = [{"type": "status", "message": "Web Search 工具已启用，等待模型决定是否调用。"}]
    async with httpx.AsyncClient(timeout=300) as client:
        messages = [*tool_payload.get("messages", [])]
        last_payload = None
        forced_once = False
        for _ in range(max_rounds):
            request_payload = dict(tool_payload)
            request_payload["messages"] = messages
            resp = await client.post(target, json=request_payload, headers=headers)
            resp.raise_for_status()
            last_payload = resp.json()
            message = last_payload.get("choices", [{}])[0].get("message", {})
            tool_calls = message.get("tool_calls") or []
            if not tool_calls:
                dsml_tool_calls = _parse_dsml_tool_calls(message.get("reasoning_content") or message.get("reasoning") or "")
                if dsml_tool_calls:
                    tool_events.append({"type": "retry", "message": "模型输出了伪工具调用，已转换为真实 web_search。"})
                    tool_events.extend(await _execute_chat_tool_calls(messages, dsml_tool_calls, message))
                    continue
            if not tool_calls:
                content = message.get("content") or ""
                if message.get("reasoning_content"):
                    message["reasoning_content"] = _strip_dsml_tool_blocks(message.get("reasoning_content") or "")
                if not forced_once and _looks_like_missed_web_search(content):
                    tool_events.append({"type": "retry", "message": "模型表示无法联网或不确定，已强制调用 web_search。"})
                    tool_payload = _force_web_search_tool_choice(tool_payload)
                    forced_once = True
                    continue
                tool_events.append({"type": "skip", "message": "模型本轮未调用 web_search。"})
                last_payload["tool_events"] = tool_events
                messages.append(message)
                last_payload["_context_state"] = {"kind": "chat_messages", "messages": messages}
                return last_payload
            tool_events.extend(await _execute_chat_tool_calls(messages, tool_calls, message))
        tool_events.append({"type": "limit", "message": "工具调用达到轮数上限，已请求模型基于现有结果作答。"})
        final_payload = dict(tool_payload)
        final_payload["messages"] = messages
        final_payload.pop("tools", None)
        final_payload.pop("tool_choice", None)
        final = await client.post(target, json=final_payload, headers=headers)
        final.raise_for_status()
        final_json = final.json() if last_payload is not None else {}
        final_json["tool_events"] = tool_events
        final_message = final_json.get("choices", [{}])[0].get("message", {})
        if final_message:
            messages.append(final_message)
        final_json["_context_state"] = {"kind": "chat_messages", "messages": messages}
        return final_json


async def _stream_chat_with_tools(
    target: str,
    headers: dict[str, str],
    payload: dict,
    max_rounds: int = 4,
    on_complete=None,
):
    import httpx
    tool_payload = dict(payload)
    tool_payload["stream"] = True
    messages = [*tool_payload.get("messages", [])]
    if tool_payload.get("tools"):
        yield _tool_event_chunk({"type": "status", "message": "Web Search 工具已启用，等待模型决定是否调用。"})
    async with httpx.AsyncClient(timeout=300) as client:
        for round_index in range(max_rounds):
            request_payload = dict(tool_payload)
            request_payload["messages"] = messages
            tool_acc: dict[int, dict] = {}
            finish_reason = None
            reasoning_buffer = ""
            content_buffer = ""
            reasoning_streamed = False
            try:
                async with client.stream("POST", target, json=request_payload, headers=headers) as resp:
                    if resp.status_code >= 400:
                        error_text = await resp.aread()
                        yield "data: " + json.dumps({"error": error_text.decode("utf-8", errors="replace")}) + "\n\n"
                        return
                    buffer = ""
                    async for text in resp.aiter_text():
                        buffer += text
                        lines = buffer.split("\n")
                        buffer = lines.pop()
                        for line in lines:
                            if not line.startswith("data: "):
                                continue
                            data_text = line[6:].strip()
                            if not data_text or data_text == "[DONE]":
                                continue
                            try:
                                chunk = json.loads(data_text)
                            except Exception:
                                continue
                            choice = (chunk.get("choices") or [{}])[0]
                            delta = choice.get("delta") or {}
                            finish_reason = choice.get("finish_reason") or finish_reason
                            for delta_call in delta.get("tool_calls") or []:
                                _merge_tool_call_delta(tool_acc, delta_call)
                            reasoning_delta = delta.get("reasoning_content") or delta.get("reasoning") or delta.get("thinking") or ""
                            if reasoning_delta:
                                reasoning_buffer += reasoning_delta
                                if not tool_payload.get("tools"):
                                    reasoning_streamed = True
                                    yield _openai_chunk(reasoning=reasoning_delta)
                            if delta.get("content"):
                                content_buffer += delta.get("content")
                                clean_chunk = dict(chunk)
                                clean_choice = dict(choice)
                                clean_delta = {"content": delta.get("content")}
                                clean_choice["delta"] = clean_delta
                                clean_chunk["choices"] = [clean_choice]
                                yield "data: " + json.dumps(clean_chunk, ensure_ascii=False) + "\n\n"
            except Exception as exc:
                yield "data: " + json.dumps({"error": str(exc)}) + "\n\n"
                return
            tool_calls = [tool_acc[idx] for idx in sorted(tool_acc)]
            if not tool_calls:
                dsml_tool_calls = _parse_dsml_tool_calls(reasoning_buffer)
                if dsml_tool_calls:
                    yield _tool_event_chunk({"type": "retry", "message": "模型输出了伪工具调用，已转换为真实 web_search。"})
                    tool_calls = dsml_tool_calls
            if tool_calls or finish_reason == "tool_calls":
                assistant_message = {"role": "assistant", "content": content_buffer, "tool_calls": tool_calls}
                if reasoning_buffer:
                    assistant_message["reasoning_content"] = reasoning_buffer
                events = await _execute_chat_tool_calls(messages, tool_calls, assistant_message)
                for event in events:
                    yield _tool_event_chunk(event)
                continue
            clean_reasoning = _strip_dsml_tool_blocks(reasoning_buffer)
            if clean_reasoning and not reasoning_streamed:
                yield _openai_chunk(reasoning=clean_reasoning)
            final_message = {"role": "assistant", "content": content_buffer}
            if clean_reasoning:
                final_message["reasoning_content"] = clean_reasoning
            messages.append(final_message)
            if on_complete:
                on_complete({"kind": "chat_messages", "messages": messages})
            yield "data: [DONE]\n\n"
            return
        yield _tool_event_chunk({"type": "limit", "message": "工具调用达到轮数上限，已停止继续搜索并请求最终回答。"})
        final_payload = dict(payload)
        final_payload["messages"] = messages
        final_payload["stream"] = True
        final_payload.pop("tools", None)
        final_payload.pop("tool_choice", None)
        try:
            async with client.stream("POST", target, json=final_payload, headers=headers) as resp:
                async for chunk in resp.aiter_bytes():
                    yield chunk
        except Exception as exc:
            yield "data: " + json.dumps({"error": str(exc)}) + "\n\n"


async def _complete_with_anthropic_tools(target: str, headers: dict[str, str], payload: dict, max_rounds: int = 3) -> dict:
    import httpx
    tool_payload = dict(payload)
    tool_payload["stream"] = False
    tool_events = [{"type": "status", "message": "Web Search 工具已启用，等待模型决定是否调用。"}]
    async with httpx.AsyncClient(timeout=300) as client:
        messages = [*tool_payload.get("messages", [])]
        last_payload = None
        for _ in range(max_rounds):
            request_payload = dict(tool_payload)
            request_payload["messages"] = messages
            resp = await client.post(target, json=request_payload, headers=headers)
            resp.raise_for_status()
            last_payload = resp.json()
            uses = [part for part in last_payload.get("content", []) if part.get("type") == "tool_use"]
            if not uses:
                tool_events.append({"type": "skip", "message": "模型本轮未调用 web_search。"})
                last_payload["tool_events"] = tool_events
                messages.append({"role": "assistant", "content": last_payload.get("content", [])})
                last_payload["_context_state"] = {"kind": "anthropic_messages", "messages": messages}
                return last_payload
            messages.append({"role": "assistant", "content": last_payload.get("content", [])})
            tool_results = []
            for use in uses:
                tool_events.append({
                    "type": "call",
                    "name": use.get("name") or "",
                    "query": (use.get("input") or {}).get("query") or "",
                    "limit": (use.get("input") or {}).get("limit") or "",
                })
                if use.get("name") != "web_search":
                    result = f"Unsupported tool: {use.get('name')}"
                else:
                    try:
                        result = await _run_web_search_tool(use.get("input") or {})
                    except Exception as exc:
                        result = f"web_search failed: {type(exc).__name__}: {exc}"
                tool_events.append({"type": "result", "name": use.get("name") or "", "summary": _tool_summary(result)})
                tool_results.append({"type": "tool_result", "tool_use_id": use.get("id"), "content": result})
            messages.append({"role": "user", "content": tool_results})
        tool_events.append({"type": "limit", "message": "工具调用达到轮数上限，已请求模型基于现有结果作答。"})
        final_payload = dict(tool_payload)
        final_payload["messages"] = messages
        final_payload.pop("tools", None)
        final = await client.post(target, json=final_payload, headers=headers)
        final.raise_for_status()
        final_json = final.json() if last_payload is not None else {}
        final_json["tool_events"] = tool_events
        messages.append({"role": "assistant", "content": final_json.get("content", [])})
        final_json["_context_state"] = {"kind": "anthropic_messages", "messages": messages}
        return final_json


async def _complete_with_responses_tools(target: str, headers: dict[str, str], payload: dict, max_rounds: int = 3) -> dict:
    import httpx
    tool_payload = dict(payload)
    tool_payload["stream"] = False
    tool_events = [{"type": "status", "message": "Web Search 工具已启用，等待模型决定是否调用。"}]
    async with httpx.AsyncClient(timeout=300) as client:
        request_payload = tool_payload
        last_payload = None
        for _ in range(max_rounds):
            resp = await client.post(target, json=request_payload, headers=headers)
            resp.raise_for_status()
            last_payload = resp.json()
            calls = [item for item in last_payload.get("output", []) if item.get("type") == "function_call"]
            if not calls:
                tool_events.append({"type": "skip", "message": "模型本轮未调用 web_search。"})
                last_payload["tool_events"] = tool_events
                last_payload["_context_state"] = {
                    "kind": "responses",
                    "previous_response_id": last_payload.get("id"),
                }
                return last_payload
            tool_outputs = []
            for call in calls:
                args = {}
                try:
                    args = json.loads(call.get("arguments") or "{}")
                except Exception:
                    args = {}
                tool_events.append({
                    "type": "call",
                    "name": call.get("name") or "",
                    "query": args.get("query") or "",
                    "limit": args.get("limit") or "",
                })
                if call.get("name") != "web_search":
                    result = f"Unsupported tool: {call.get('name')}"
                else:
                    try:
                        result = await _run_web_search_tool(args)
                    except Exception as exc:
                        result = f"web_search failed: {type(exc).__name__}: {exc}"
                tool_events.append({"type": "result", "name": call.get("name") or "", "summary": _tool_summary(result)})
                tool_outputs.append({"type": "function_call_output", "call_id": call.get("call_id"), "output": result})
            request_payload = {
                "model": tool_payload.get("model"),
                "input": tool_outputs,
                "previous_response_id": last_payload.get("id"),
                "stream": False,
                "tools": tool_payload.get("tools", []),
            }
        tool_events.append({"type": "limit", "message": "工具调用达到轮数上限，已请求模型基于现有结果作答。"})
        final_payload = dict(request_payload)
        final_payload.pop("tools", None)
        final = await client.post(target, json=final_payload, headers=headers)
        final.raise_for_status()
        final_json = final.json() if last_payload is not None else {}
        final_json["tool_events"] = tool_events
        final_json["_context_state"] = {
            "kind": "responses",
            "previous_response_id": final_json.get("id"),
        }
        return final_json


async def _stream_anthropic_with_tools(
    target: str,
    headers: dict[str, str],
    payload: dict,
    max_rounds: int = 4,
    on_complete=None,
):
    import httpx

    request_base = dict(payload)
    request_base["stream"] = True
    messages = [*request_base.get("messages", [])]
    if request_base.get("tools"):
        yield _tool_event_chunk({"type": "status", "message": "Web Search 工具已启用，等待模型决定是否调用。"})

    async with httpx.AsyncClient(timeout=300) as client:
        for _round in range(max_rounds):
            request_payload = dict(request_base)
            request_payload["messages"] = messages
            blocks: dict[int, dict] = {}
            json_buffers: dict[int, str] = {}
            try:
                async with client.stream("POST", target, json=request_payload, headers=headers) as response:
                    if response.status_code >= 400:
                        error = (await response.aread()).decode("utf-8", errors="replace")
                        yield "data: " + json.dumps({"error": error}, ensure_ascii=False) + "\n\n"
                        return
                    async for line in response.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        raw = line[6:].strip()
                        if not raw:
                            continue
                        try:
                            event = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        event_type = event.get("type")
                        index = int(event.get("index") or 0)
                        if event_type == "content_block_start":
                            block = dict(event.get("content_block") or {})
                            blocks[index] = block
                            if block.get("type") == "tool_use":
                                json_buffers[index] = json.dumps(block.get("input") or {}) if block.get("input") else ""
                        elif event_type == "content_block_delta":
                            delta = event.get("delta") or {}
                            block = blocks.setdefault(index, {"type": "text", "text": ""})
                            if delta.get("type") == "text_delta":
                                text_delta = delta.get("text") or ""
                                block["text"] = (block.get("text") or "") + text_delta
                                if text_delta:
                                    yield _openai_chunk(content=text_delta)
                            elif delta.get("type") == "thinking_delta":
                                thinking = delta.get("thinking") or ""
                                block["thinking"] = (block.get("thinking") or "") + thinking
                                if thinking:
                                    yield _openai_chunk(reasoning=thinking)
                            elif delta.get("type") == "signature_delta":
                                block["signature"] = (block.get("signature") or "") + (delta.get("signature") or "")
                            elif delta.get("type") == "input_json_delta":
                                json_buffers[index] = json_buffers.get(index, "") + (delta.get("partial_json") or "")
            except Exception as exc:
                yield "data: " + json.dumps({"error": str(exc)}, ensure_ascii=False) + "\n\n"
                return

            ordered_blocks = [blocks[index] for index in sorted(blocks)]
            uses = []
            for index, block in sorted(blocks.items()):
                if block.get("type") != "tool_use":
                    continue
                try:
                    block["input"] = json.loads(json_buffers.get(index) or "{}")
                except json.JSONDecodeError:
                    block["input"] = {}
                uses.append(block)
            if not uses:
                messages.append({"role": "assistant", "content": ordered_blocks})
                if on_complete:
                    on_complete({"kind": "anthropic_messages", "messages": messages})
                yield "data: [DONE]\n\n"
                return

            messages.append({"role": "assistant", "content": ordered_blocks})
            tool_results = []
            for use in uses:
                args = use.get("input") or {}
                call_event = {"type": "call", "name": use.get("name") or "", "query": args.get("query") or "", "limit": args.get("limit") or ""}
                yield _tool_event_chunk(call_event)
                if use.get("name") != "web_search":
                    result = f"Unsupported tool: {use.get('name')}"
                else:
                    try:
                        result = await _run_web_search_tool(args)
                    except Exception as exc:
                        result = f"web_search failed: {type(exc).__name__}: {exc}"
                yield _tool_event_chunk({"type": "result", "name": use.get("name") or "", "summary": _tool_summary(result)})
                tool_results.append({"type": "tool_result", "tool_use_id": use.get("id"), "content": result})
            messages.append({"role": "user", "content": tool_results})

        yield "data: " + json.dumps({"error": "Tool call round limit reached"}) + "\n\n"
        yield "data: [DONE]\n\n"


async def _stream_responses_with_tools(
    target: str,
    headers: dict[str, str],
    payload: dict,
    max_rounds: int = 4,
    on_complete=None,
):
    import httpx

    request_payload = dict(payload)
    request_payload["stream"] = True
    if request_payload.get("tools"):
        yield _tool_event_chunk({"type": "status", "message": "Web Search 工具已启用，等待模型决定是否调用。"})

    async with httpx.AsyncClient(timeout=300) as client:
        for _round in range(max_rounds):
            response_id = ""
            calls: dict[str, dict] = {}
            try:
                async with client.stream("POST", target, json=request_payload, headers=headers) as response:
                    if response.status_code >= 400:
                        error = (await response.aread()).decode("utf-8", errors="replace")
                        yield "data: " + json.dumps({"error": error}, ensure_ascii=False) + "\n\n"
                        return
                    async for line in response.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        raw = line[6:].strip()
                        if not raw or raw == "[DONE]":
                            continue
                        try:
                            event = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        event_type = event.get("type", "")
                        response_obj = event.get("response") or {}
                        response_id = response_obj.get("id") or response_id
                        if event_type in {"response.output_text.delta", "response.refusal.delta"}:
                            yield _openai_chunk(content=event.get("delta") or "")
                        elif event_type in {"response.reasoning_summary_text.delta", "response.reasoning_text.delta"}:
                            yield _openai_chunk(reasoning=event.get("delta") or "")
                        elif event_type == "response.output_item.added":
                            item = event.get("item") or {}
                            if item.get("type") == "function_call":
                                key = item.get("id") or item.get("call_id") or str(event.get("output_index") or 0)
                                calls[key] = {
                                    "name": item.get("name") or "",
                                    "call_id": item.get("call_id") or "",
                                    "arguments": item.get("arguments") or "",
                                }
                        elif event_type == "response.function_call_arguments.delta":
                            key = event.get("item_id") or str(event.get("output_index") or 0)
                            call = calls.setdefault(key, {"name": "", "call_id": "", "arguments": ""})
                            call["arguments"] += event.get("delta") or ""
                        elif event_type == "response.function_call_arguments.done":
                            key = event.get("item_id") or str(event.get("output_index") or 0)
                            call = calls.setdefault(key, {"name": "", "call_id": "", "arguments": ""})
                            call["name"] = event.get("name") or call["name"]
                            call["arguments"] = event.get("arguments") or call["arguments"]
                        elif event_type == "response.completed":
                            response_id = response_obj.get("id") or response_id
                            for item in response_obj.get("output", []):
                                if item.get("type") != "function_call":
                                    continue
                                key = item.get("id") or item.get("call_id") or str(len(calls))
                                calls[key] = {
                                    "name": item.get("name") or "",
                                    "call_id": item.get("call_id") or "",
                                    "arguments": item.get("arguments") or "",
                                }
            except Exception as exc:
                yield "data: " + json.dumps({"error": str(exc)}, ensure_ascii=False) + "\n\n"
                return

            if not calls:
                if on_complete:
                    on_complete({"kind": "responses", "previous_response_id": response_id})
                yield "data: [DONE]\n\n"
                return

            outputs = []
            for call in calls.values():
                try:
                    args = json.loads(call.get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                yield _tool_event_chunk({"type": "call", "name": call.get("name") or "", "query": args.get("query") or "", "limit": args.get("limit") or ""})
                if call.get("name") != "web_search":
                    result = f"Unsupported tool: {call.get('name')}"
                else:
                    try:
                        result = await _run_web_search_tool(args)
                    except Exception as exc:
                        result = f"web_search failed: {type(exc).__name__}: {exc}"
                yield _tool_event_chunk({"type": "result", "name": call.get("name") or "", "summary": _tool_summary(result)})
                outputs.append({"type": "function_call_output", "call_id": call.get("call_id"), "output": result})
            request_payload = {
                "model": payload.get("model"),
                "input": outputs,
                "previous_response_id": response_id,
                "stream": True,
                "tools": payload.get("tools", []),
            }

        yield "data: " + json.dumps({"error": "Tool call round limit reached"}) + "\n\n"
        yield "data: [DONE]\n\n"


def _v2_event(event_type: str, **payload) -> str:
    return "data: " + json.dumps({"type": event_type, **payload}, ensure_ascii=False) + "\n\n"


async def _normalize_v2_stream(source, candidate_id: str):
    yield _v2_event("start", candidate_id=candidate_id)
    buffer = ""
    async for raw_chunk in source:
        chunk = raw_chunk.decode("utf-8", errors="replace") if isinstance(raw_chunk, bytes) else str(raw_chunk)
        buffer += chunk
        frames = buffer.split("\n\n")
        buffer = frames.pop()
        for frame in frames:
            data_line = next((line[6:] for line in frame.splitlines() if line.startswith("data: ")), "")
            data_line = data_line.strip()
            if not data_line or data_line == "[DONE]":
                continue
            try:
                event = json.loads(data_line)
            except json.JSONDecodeError:
                continue
            if event.get("error"):
                yield _v2_event("error", message=str(event.get("error")))
                continue
            tool_event = event.get("tool_event")
            if tool_event:
                tool_payload = {key: value for key, value in tool_event.items() if key != "type"}
                if tool_event.get("type") == "call":
                    yield _v2_event("tool_call", **tool_payload)
                elif tool_event.get("type") == "result":
                    yield _v2_event("tool_result", **tool_payload)
                else:
                    yield _v2_event("tool_status", status=tool_event.get("type"), **tool_payload)
                continue
            delta = (event.get("choices") or [{}])[0].get("delta") or {}
            if delta.get("reasoning_content") or delta.get("reasoning") or delta.get("thinking"):
                yield _v2_event("reasoning_delta", delta=delta.get("reasoning_content") or delta.get("reasoning") or delta.get("thinking"))
            if delta.get("content"):
                yield _v2_event("content_delta", delta=delta.get("content"))
    yield _v2_event("done", candidate_id=candidate_id, finish_reason="stop")
    yield "data: [DONE]\n\n"


@app.middleware("http")
async def local_only_api(request: Request, call_next):
    if request.url.path.startswith("/api/") and not _remote_api_enabled():
        if not _is_local_host(request.client.host if request.client else None):
            return JSONResponse(status_code=403, content={"error": "Remote API access is disabled"})
    return await call_next(request)


async def _reject_remote_websocket(websocket: WebSocket) -> bool:
    if _remote_api_enabled() or _is_local_host(websocket.client.host if websocket.client else None):
        return False
    await websocket.close(code=1008)
    return True


# ── Config endpoints ──────────────────────────────────────────

@app.get("/api/config")
def get_config():
    return cfg.get_config().model_dump()


@app.post("/api/config")
def save_config(config: AppConfig):
    path = cfg.save_config(config)
    return {"ok": True, "path": str(path)}


@app.post("/api/config/save-as")
def save_config_as(body: dict):
    name = body.get("name", "default")
    config = AppConfig(**body.get("config", cfg.get_config().model_dump()))
    path = cfg.save_config(config, name)
    return {"ok": True, "path": str(path)}


@app.get("/api/config/list")
def list_configs():
    return {"configs": cfg.list_configs()}


@app.post("/api/config/load")
def load_config(body: dict):
    name = body.get("name", "default")
    config = cfg.load_config(name)
    return config.model_dump()


@app.post("/api/config/delete")
def delete_config(body: dict):
    name = cfg._sanitize_name(body.get("name", "default"))
    if name == "default":
        return JSONResponse(status_code=400, content={"error": "Cannot delete default config"})
    path = cfg.CONFIG_DIR / f"{name}.json"
    if path.exists():
        path.unlink()
        return {"ok": True}
    return JSONResponse(status_code=404, content={"error": "Config not found"})


@app.post("/api/config/import")
async def import_config(body: dict):
    content = body.get("content", "{}")
    config = cfg.import_config(content)
    return config.model_dump()


@app.get("/api/scan-models")
def scan_models(dir: str):
    models = cfg.scan_models(dir)
    return {"models": [m.model_dump() for m in models]}


@app.get("/api/detect-server")
def detect_server(llama_cpp_dir: str):
    path = cfg.detect_server_binary(llama_cpp_dir)
    return {"path": path, "found": bool(path)}


# ── Server control endpoints ──────────────────────────────────

@app.post("/api/server/start")
async def server_start():
    try:
        config = cfg.get_config()
        await process_manager.start(config)
        return {"ok": True}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.post("/api/server/stop")
async def server_stop():
    await process_manager.stop()
    return {"ok": True}


@app.get("/api/server/status")
def server_status():
    return process_manager.get_status().model_dump()


@app.get("/api/server/health")
async def server_health():
    """Check if llama-server is accepting requests."""
    import httpx
    config = cfg.get_config()
    url = f"http://{config.server.host}:{config.server.port}/health"
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            resp = await client.get(url)
            return {"ready": resp.status_code == 200, "status": resp.status_code}
    except Exception:
        return {"ready": False, "status": "unreachable"}


@app.get("/api/server/logs")
def server_logs():
    return {"logs": process_manager.get_logs()}


@app.post("/api/server/logs/clear")
def clear_logs():
    process_manager.clear_logs()
    return {"ok": True}


# ── Update endpoints ──────────────────────────────────────────

@app.get("/api/update/check")
async def update_check():
    config = cfg.get_config()
    if not config.llama_cpp_dir:
        return JSONResponse(status_code=400, content={"error": "llama.cpp directory not set"})
    return await update_manager.check_update(config.llama_cpp_dir)


@app.post("/api/update/pull")
async def update_pull(request: Request):
    config = cfg.get_config()
    if not config.llama_cpp_dir:
        return JSONResponse(status_code=400, content={"error": "llama.cpp directory not set"})
    body = await request.json() if request.headers.get("content-type","") == "application/json" else {}
    force = body.get("force", False)
    return await update_manager.pull_update(config.llama_cpp_dir, force=force)


@app.post("/api/update/compile")
async def update_compile():
    config = cfg.get_config()
    if not config.llama_cpp_dir:
        return JSONResponse(status_code=400, content={"error": "llama.cpp directory not set"})
    try:
        await update_manager.start_compile(config.llama_cpp_dir, config.compile.command)
        return {"ok": True}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.post("/api/update/compile/stop")
async def compile_stop():
    await update_manager.stop()
    return {"ok": True}


@app.get("/api/update/compile/logs")
def compile_logs():
    return {"logs": update_manager.get_compile_logs(), "is_compiling": update_manager.is_compiling()}


# ── WebSocket: real-time server logs ──────────────────────────

@app.websocket("/ws/logs")
async def ws_logs(websocket: WebSocket):
    if await _reject_remote_websocket(websocket):
        return
    await websocket.accept()
    q = process_manager.subscribe()
    try:
        for line in process_manager.get_logs():
            await websocket.send_text(line)
        while True:
            text = await q.get()
            await websocket.send_text(text)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        process_manager.unsubscribe(q)


# ── WebSocket: real-time compile logs ─────────────────────────

@app.websocket("/ws/compile")
async def ws_compile(websocket: WebSocket):
    if await _reject_remote_websocket(websocket):
        return
    await websocket.accept()
    q = update_manager.subscribe()
    try:
        for line in update_manager.get_compile_logs():
            await websocket.send_text(line)
        while True:
            text = await q.get()
            await websocket.send_text(text)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        update_manager.unsubscribe(q)


# ── Chat proxy ──────────────────────────────────────────────

@app.post("/api/chat")
async def chat_proxy(request: Request):
    """Proxy a chat turn while preserving provider-specific branch context."""
    import httpx

    config = cfg.get_config()
    data = await request.json()
    provider_id = data.get("provider", "local")
    raw_messages = data.get("messages", [])
    if not isinstance(raw_messages, list):
        return JSONResponse(status_code=400, content={"error": "messages must be a list"})
    messages = raw_messages
    use_web_tool = bool(data.get("web_search_tool") or data.get("web_search") is True)
    messages = await _messages_with_search_context(messages, bool(data.get("search_summary")))
    messages = _messages_with_web_tool_guidance(messages, use_web_tool)
    stream = bool(data.get("stream", True))
    event_format = data.get("event_format") or "legacy"
    conversation_id = str(data.get("conversation_id") or uuid.uuid4().hex)
    parent_candidate_id = str(data.get("parent_candidate_id") or "")
    candidate_id = uuid.uuid4().hex

    provider_config = None
    if provider_id not in {"local", "deepseek-api"}:
        provider_config = providers.get_provider(provider_id)
        if not provider_config:
            return JSONResponse(status_code=404, content={"error": f"Provider not found: {provider_id}"})

    if provider_id == "deepseek-api" and not provider_config:
        provider_config = providers.get_provider("deepseek")

    if provider_config:
        if not provider_config.enabled:
            return JSONResponse(status_code=409, content={"error": f"Provider is disabled: {provider_config.name}"})
        try:
            headers = _provider_headers(provider_config)
        except RuntimeError as exc:
            return JSONResponse(status_code=409, content={"error": str(exc)})
        target, payload = _external_chat_request(provider_config, data, messages)
        provider_kind = provider_config.kind
    else:
        target = f"http://{config.server.host}:{config.server.port}/v1/chat/completions"
        headers = {"Content-Type": "application/json"}
        payload = _local_chat_payload(data, config, messages)
        provider_kind = "openai_chat"

    model = str(payload.get("model") or data.get("model") or "default")
    latest_user = next((dict(message) for message in reversed(raw_messages) if message.get("role") == "user"), None)
    if parent_candidate_id:
        parent = conversation_store.get(conversation_id, parent_candidate_id)
        if not parent:
            return JSONResponse(status_code=410, content={"error": "Conversation context expired"})
        if parent.provider_id != provider_id or parent.model != model:
            return JSONResponse(status_code=409, content={"error": "Parent candidate uses a different provider or model"})
        if not latest_user:
            return JSONResponse(status_code=400, content={"error": "A user message is required"})
        if parent.kind == "chat_messages":
            payload["messages"] = [*parent.state.get("messages", []), latest_user]
        elif parent.kind == "anthropic_messages":
            payload["messages"] = [
                *parent.state.get("messages", []),
                {"role": "user", "content": latest_user.get("content", "")},
            ]
        elif parent.kind == "responses":
            payload["input"] = [{"role": "user", "content": latest_user.get("content", "")}]
            payload["previous_response_id"] = parent.state.get("previous_response_id")

    captured_state: dict = {}

    def save_context(state: dict) -> None:
        captured_state.clear()
        captured_state.update(state)
        conversation_store.put(
            conversation_id,
            candidate_id,
            CandidateContext(
                provider_id=provider_id,
                model=model,
                kind=state.get("kind", "chat_messages"),
                state={key: value for key, value in state.items() if key != "kind"},
                updated_at=time.time(),
            ),
        )

    try:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    except TypeError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})

    if stream:
        if provider_kind in {"deepseek", "openai_chat", "openai_compatible"}:
            source = _stream_chat_with_tools(target, headers, payload, on_complete=save_context)
        elif provider_kind == "anthropic":
            source = _stream_anthropic_with_tools(target, headers, payload, on_complete=save_context)
        else:
            source = _stream_responses_with_tools(target, headers, payload, on_complete=save_context)
        if event_format == "v2":
            source = _normalize_v2_stream(source, candidate_id)
        return StreamingResponse(source, media_type="text/event-stream")

    if use_web_tool:
        try:
            if provider_kind in {"deepseek", "openai_chat", "openai_compatible"}:
                payload = await _complete_with_chat_tools(target, headers, payload)
            elif provider_kind == "anthropic":
                raw_payload = await _complete_with_anthropic_tools(target, headers, payload)
                state = raw_payload.pop("_context_state", {})
                payload = _normalize_non_stream_response(provider_kind, raw_payload)
                payload["_context_state"] = state
            else:
                raw_payload = await _complete_with_responses_tools(target, headers, payload)
                state = raw_payload.pop("_context_state", {})
                payload = _normalize_non_stream_response(provider_kind, raw_payload)
                payload["_context_state"] = state
        except Exception as exc:
            return JSONResponse(status_code=400, content={"error": str(exc)})
    else:
        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(target, content=body, headers=headers)
        if resp.status_code >= 400:
            return JSONResponse(status_code=resp.status_code, content={"error": resp.text})
        raw_payload = resp.json()
        if provider_kind in {"deepseek", "openai_chat", "openai_compatible"}:
            payload = raw_payload
            message = payload.get("choices", [{}])[0].get("message", {})
            state = {"kind": "chat_messages", "messages": [*payload.get("messages", []), message]}
            # The request payload, not the provider response, owns the prior messages.
            state["messages"] = [*json.loads(body.decode("utf-8")).get("messages", []), message]
        elif provider_kind == "anthropic":
            payload = _normalize_non_stream_response(provider_kind, raw_payload)
            state = {
                "kind": "anthropic_messages",
                "messages": [*json.loads(body.decode("utf-8")).get("messages", []), {"role": "assistant", "content": raw_payload.get("content", [])}],
            }
        else:
            payload = _normalize_non_stream_response(provider_kind, raw_payload)
            state = {"kind": "responses", "previous_response_id": raw_payload.get("id")}
        payload["_context_state"] = state

    context_state = payload.pop("_context_state", {})
    if context_state:
        save_context(context_state)
    message = payload.get("choices", [{}])[0].get("message", {})
    if event_format == "v2":
        return {
            "candidate_id": candidate_id,
            "content": message.get("content") or "",
            "reasoning": message.get("reasoning_content") or "",
            "tool_events": payload.get("tool_events") or [],
            "finish_reason": payload.get("choices", [{}])[0].get("finish_reason") or "stop",
        }
    payload["candidate_id"] = candidate_id
    return JSONResponse(content=payload)


@app.delete("/api/chat/conversations/{conversation_id}")
async def clear_chat_conversation(conversation_id: str):
    conversation_store.delete(conversation_id)
    return {"ok": True}


@app.get("/api/chat/models")
async def list_models(provider: str = "local"):
    """List local or DeepSeek models."""
    import httpx
    provider_config = providers.get_provider(provider)
    if provider_config:
        return {"data": [{"id": model} for model in provider_config.models]}
    config = cfg.get_config()
    target = f"http://{config.server.host}:{config.server.port}/v1/models"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(target)
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=502)


@app.get("/api/chat/providers")
async def chat_providers():
    return {"providers": [{"id": "local", "name": "本地 llama-server", "kind": "local", "configured": True}, *providers.list_providers()]}


@app.get("/api/search/settings")
async def get_search_settings():
    return search_manager.public_settings()


@app.put("/api/search/settings")
async def put_search_settings(body: dict):
    try:
        return search_manager.save_settings(body)
    except Exception as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@app.post("/api/chat/providers")
async def save_chat_provider(body: dict):
    try:
        return providers.save_provider(body)
    except Exception as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@app.delete("/api/chat/providers/{provider_id}")
async def delete_chat_provider(provider_id: str):
    if providers.delete_provider(provider_id):
        return {"ok": True}
    return JSONResponse(status_code=404, content={"error": "Provider not found or cannot be deleted"})


@app.post("/api/chat/providers/{provider_id}/models")
async def fetch_provider_models(provider_id: str):
    import httpx
    provider = providers.get_provider(provider_id)
    if not provider:
        return JSONResponse(status_code=404, content={"error": "Provider not found"})
    try:
        headers = _provider_headers(provider)
        target = _provider_models_url(provider)
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(target, headers=headers)
        if resp.status_code >= 400:
            return JSONResponse(status_code=resp.status_code, content={"error": resp.text})
        data = resp.json()
        models = []
        if isinstance(data, dict):
            raw_models = data.get("data") or data.get("models") or []
            for item in raw_models:
                if isinstance(item, str):
                    models.append(item)
                elif isinstance(item, dict) and item.get("id"):
                    models.append(item["id"])
        provider.models = sorted(set(models))
        if provider.models and provider.default_model not in provider.models:
            provider.default_model = provider.models[0]
        return providers.save_provider(provider.model_dump())
    except RuntimeError as exc:
        return JSONResponse(status_code=409, content={"error": str(exc)})
    except Exception as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@app.get("/api/drives")
def list_drives():
    """List available drives (Windows) or ['/'] (Linux)."""
    return {"drives": cfg.list_drives()}


@app.get("/api/browse")
def browse_dir(dir: str):
    """Browse directory contents for folder picker."""
    return {"entries": cfg.browse_directory(dir)}


# ── Download endpoints ────────────────────────────────────────

@app.post("/api/download/start")
async def download_start(body: dict):
    target_dir = body.get("target_dir", "")
    if not target_dir:
        return JSONResponse(status_code=400, content={"error": "target_dir required"})
    try:
        await download_manager.start_download(target_dir)
        return {"ok": True}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.post("/api/download/stop")
async def download_stop():
    await download_manager.stop()
    return {"ok": True}


@app.get("/api/download/status")
def download_status():
    return {"is_downloading": download_manager.is_downloading(), "logs": download_manager.get_logs()}


@app.websocket("/ws/download")
async def ws_download(websocket: WebSocket):
    if await _reject_remote_websocket(websocket):
        return
    await websocket.accept()
    q = download_manager.subscribe()
    try:
        for line in download_manager.get_logs():
            await websocket.send_text(line)
        while True:
            text = await q.get()
            await websocket.send_text(text)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        download_manager.unsubscribe(q)


# ── Optimizer endpoints ────────────────────────────────────────

@app.post("/api/optimize/start")
async def optimize_start(request: Request):
    global _optimizer_task
    body = await request.json()
    config = cfg.get_config()
    try:
        if _optimizer_task and not _optimizer_task.done():
            return JSONResponse(status_code=400, content={"error": "Optimization already running."})
        _optimizer_task = asyncio.create_task(optimizer.run_optimization(
            llama_cpp_dir=config.llama_cpp_dir,
            model_path=config.model_path,
            threads=config.basic.threads,
            ngl_range=tuple(body.get("ngl_range", [0, 99])),
            n_cpu_moe_range=tuple(body.get("n_cpu_moe_range", [0, 99])),
            ctx_options=body.get("ctx_options", [4096]),
            kv_options=body.get("kv_options", ["f16"]),
            n_trials=body.get("n_trials", 50),
            mmap=config.basic.mmap,
            mlock=config.basic.mlock,
            kv_offload=config.basic.kv_offload,
            flash_attn=config.basic.flash_attn,
            fit_target=config.basic.fit_target if config.basic.fit_enabled else 0,
        ))
        return {"ok": True}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@app.post("/api/optimize/stop")
async def optimize_stop():
    await optimizer.stop()
    return {"ok": True}


@app.get("/api/optimize/status")
def optimize_status():
    return optimizer.get_status()


@app.websocket("/ws/optimize")
async def ws_optimize(websocket: WebSocket):
    if await _reject_remote_websocket(websocket):
        return
    await websocket.accept()
    q = optimizer.subscribe()
    try:
        for line in optimizer.get_status()["logs"]:
            await websocket.send_text(line if isinstance(line, str) else json.dumps(line))
        while True:
            text = await q.get()
            await websocket.send_text(text if isinstance(text, str) else json.dumps(text))
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        optimizer.unsubscribe(q)


# ── Static files ──────────────────────────────────────────────

@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")
