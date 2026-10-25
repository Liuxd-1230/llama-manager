"""Chat adapters — the provider-protocol layer behind /api/chat.

Deep module: a small interface (build_chat_request / stream_chat_completion /
complete_chat_completion) hides the provider-protocol knowledge — payload
building, the web-search tool loops, DSML fallback, SSE/v2 normalization and
the branch-context shapes. Routes orchestrate; protocol knowledge lives here.
See GLOSSARY.md for the vocabulary (Chat Adapters, Provider Kind, Tool Loop,
DSML, Branch Context, V2 Event Stream).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

from . import provider_manager as providers
from . import search_manager
from .models import AppConfig


# ── DSML fallback parsing ─────────────────────────────────────
# Some models emit pseudo tool calls inside reasoning as DSML blocks; the
# adapters convert them into real web_search calls and strip them from text
# that reaches the UI.

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


def strip_dsml_tool_blocks(text: str) -> str:
    return DSML_BLOCK_RE.sub("", str(text or "")).strip()


def parse_dsml_tool_calls(text: str) -> list[dict]:
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


# ── SSE chunk helpers ─────────────────────────────────────────

def _openai_chunk(content: str = "", reasoning: str = "") -> str:
    delta = {}
    if content:
        delta["content"] = content
    if reasoning:
        delta["reasoning_content"] = reasoning
    return "data: " + json.dumps({"choices": [{"delta": delta}]}, ensure_ascii=False) + "\n\n"


def _tool_event_chunk(event: dict) -> str:
    return "data: " + json.dumps({"tool_event": event}, ensure_ascii=False) + "\n\n"


# ── Non-stream normalization ──────────────────────────────────

def normalize_non_stream_response(provider_kind: str, payload: dict) -> dict:
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


# ── V2 event stream ───────────────────────────────────────────

def _v2_event(event_type: str, **payload) -> str:
    return "data: " + json.dumps({"type": event_type, **payload}, ensure_ascii=False) + "\n\n"


async def normalize_v2_stream(source, candidate_id: str):
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
            if event.get("timings"):
                yield _v2_event("timings", **event["timings"])
            if event.get("usage"):
                yield _v2_event("usage", **event["usage"])
            if delta.get("reasoning_content") or delta.get("reasoning") or delta.get("thinking"):
                yield _v2_event("reasoning_delta", delta=delta.get("reasoning_content") or delta.get("reasoning") or delta.get("thinking"))
            if delta.get("content"):
                yield _v2_event("content_delta", delta=delta.get("content"))
    yield _v2_event("done", candidate_id=candidate_id, finish_reason="stop")
    yield "data: [DONE]\n\n"


# ── Request building ──────────────────────────────────────────

DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEFAULT_BASE_URLS = {
    "deepseek": "https://api.deepseek.com",
    "openai_chat": "https://api.openai.com/v1",
    "openai_responses": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "openai_compatible": "",
}


def _chat_completions_url(base_url: str) -> str:
    base = (base_url or DEEPSEEK_BASE_URL).rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def local_base_url(config: AppConfig) -> str:
    """Loopback URL for the managed llama-server. A client connection to
    0.0.0.0 is invalid on Windows (WinError 10049), so map it back."""
    host = config.server.host if config.server.host not in ("", "0.0.0.0") else "127.0.0.1"
    return f"http://{host}:{config.server.port}"


def _provider_api_key(provider: providers.ProviderConfig) -> str:
    return providers.resolve_api_key(provider)


def provider_headers(provider: providers.ProviderConfig) -> dict[str, str]:
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


def provider_models_url(provider: providers.ProviderConfig) -> str:
    base = _provider_base_url(provider)
    if not base:
        raise RuntimeError("Base URL is required")
    return f"{base}/models"


# ── Web tool guidance / missed-search detection ───────────────

def messages_with_web_tool_guidance(messages: list[dict], enabled: bool) -> list[dict]:
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


_MISSED_WEB_SEARCH_PATTERN = re.compile(
    r"(无法|不能|没法)(联网|连接互联网|访问互联网|浏览网页|获取(最新|实时))"
    r"|(don't|do not|cannot|can't)\s+(have\s+|be able to\s+)?(access|browse)\s+(the\s+)?(internet|web|online)"
    r"|beyond my (knowledge )?cutoff|knowledge cutoff",
    re.IGNORECASE,
)


def _looks_like_missed_web_search(content: str) -> bool:
    """Only refusal-to-browse intent sentences count; bare nouns like
    知识库 or real-time appear in perfectly valid answers."""
    return bool(_MISSED_WEB_SEARCH_PATTERN.search(str(content or "")))


def _force_web_search_tool_choice(payload: dict) -> dict:
    forced = dict(payload)
    forced["tool_choice"] = {"type": "function", "function": {"name": "web_search"}}
    return forced


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


def _anthropic_web_search_tool_schema() -> dict:
    fn = _web_search_tool_schema()["function"]
    return {"name": fn["name"], "description": fn["description"], "input_schema": fn["parameters"]}


# ── Tool execution ────────────────────────────────────────────
# Exactly one real tool exists today (web_search); anything else the model
# names is answered with an "Unsupported tool" stub. Introduce an injected
# tool registry only when a second real tool appears.

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


def _local_chat_payload(data: dict, config: AppConfig, messages: list[dict]) -> dict:
    sampling = config.sampling
    web_tool = bool(data.get("web_search_tool") or data.get("web_search") is True)
    if config.engine == "ninfer":
        # NInfer accepts the standard OpenAI fields; anything beyond
        # temperature/top_p is governed server-side (--top-k, --min-p...),
        # and the thinking toggle maps onto the per-request reasoning effort.
        # It validates the model id against the loaded artifact, so the field
        # is only sent when the caller actually picked one — omitting it means
        # "the loaded model", while "default" would 404.
        payload = {
            "messages": messages,
            "stream": data.get("stream", True),
            "temperature": sampling.temperature,
            "top_p": sampling.top_p,
        }
        model = data.get("model")
        if model and model != "default":
            payload["model"] = model
        if data.get("thinking_enabled") is not None:
            # The chat page sends its own effort selector value; honor it when
            # valid, otherwise fall back to the profile's configured effort.
            effort = str(data.get("reasoning_effort") or "")
            if data.get("thinking_enabled"):
                payload["reasoning_effort"] = effort if effort in {"minimal", "low", "medium", "high", "xhigh", "max"} else config.ninfer.reasoning_effort
            else:
                payload["reasoning_effort"] = "none"
        if web_tool:
            payload["tools"] = [_web_search_tool_schema()]
            payload["tool_choice"] = "auto"
        return payload
    payload = {
        "model": data.get("model") or "default",
        "messages": messages,
        "stream": data.get("stream", True),
        "temperature": sampling.temperature,
        "top_k": sampling.top_k,
        "top_p": sampling.top_p,
    }
    # Explicit per-request override for local engines. Safe to send unconditionally:
    # --jinja servers honor enable_thinking; servers on the legacy formatting path
    # (no --jinja) parse and ignore the kwarg.
    if data.get("thinking_enabled") is not None:
        payload["chat_template_kwargs"] = {"enable_thinking": bool(data.get("thinking_enabled"))}
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


@dataclass
class ChatRequest:
    """Protocol-level request for one chat turn: everything the tool loops
    need to talk to a provider, plus the kind that selects a loop."""

    provider_kind: str
    target: str
    headers: dict[str, str]
    payload: dict


def build_chat_request(*, provider_config: providers.ProviderConfig | None = None, config: AppConfig | None = None, data: dict, messages: list[dict]) -> ChatRequest:
    """Resolve endpoint URL, headers, native payload and provider kind.

    provider_config=None means the managed local engine (llama.cpp / KVMem /
    NInfer all speak the openai_chat family), which requires `config` to find
    the server address. Raises RuntimeError when a provider has no usable API
    key, ValueError when a local request arrives without config."""
    if provider_config is not None:
        headers = provider_headers(provider_config)
        target, payload = _external_chat_request(provider_config, data, messages)
        kind = provider_config.kind
    else:
        if config is None:
            raise ValueError("config is required for local engine chat requests")
        target = f"{local_base_url(config)}/v1/chat/completions"
        headers = {"Content-Type": "application/json"}
        payload = _local_chat_payload(data, config, messages)
        kind = "openai_chat"
    return ChatRequest(provider_kind=kind, target=target, headers=headers, payload=payload)


# ── Tool loops (per provider kind) ────────────────────────────
# Stream and non-stream variants per provider kind. Known asymmetries
# are preserved verbatim: the openai stream loop lacks the forced
# web_search retry, and anthropic/responses streams end with an error
# event on the round limit instead of a tool-less continuation.


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
                dsml_tool_calls = parse_dsml_tool_calls(message.get("reasoning_content") or message.get("reasoning") or "")
                if dsml_tool_calls:
                    tool_events.append({"type": "retry", "message": "模型输出了伪工具调用，已转换为真实 web_search。"})
                    tool_events.extend(await _execute_chat_tool_calls(messages, dsml_tool_calls, message))
                    continue
            if not tool_calls:
                content = message.get("content") or ""
                if message.get("reasoning_content"):
                    message["reasoning_content"] = strip_dsml_tool_blocks(message.get("reasoning_content") or "")
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
            timings: dict | None = None
            usage_stats: dict | None = None
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
                                # Stream thinking even with tools mounted: the
                                # frontend strips DSML from reasoning display.
                                reasoning_streamed = True
                                yield _openai_chunk(reasoning=reasoning_delta)
                            if chunk.get("timings"):
                                timings = chunk["timings"]
                            if chunk.get("usage"):
                                usage_stats = chunk["usage"]
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
            if timings:
                yield "data: " + json.dumps({"timings": timings}) + "\n\n"
            if usage_stats:
                yield "data: " + json.dumps({"usage": usage_stats}) + "\n\n"
            tool_calls = [tool_acc[idx] for idx in sorted(tool_acc)]
            if not tool_calls:
                dsml_tool_calls = parse_dsml_tool_calls(reasoning_buffer)
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
            clean_reasoning = strip_dsml_tool_blocks(reasoning_buffer)
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


# ── Public deep interface ─────────────────────────────────────

_OPENAI_FAMILY_KINDS = {"deepseek", "openai_chat", "openai_compatible"}


class UpstreamError(Exception):
    """The provider answered with an HTTP error status."""

    def __init__(self, status_code: int, text: str):
        super().__init__(text)
        self.status_code = status_code
        self.text = text


def stream_chat_completion(request: ChatRequest, *, candidate_id: str, event_format: str = "legacy", on_context=None):
    """Stream one chat turn as SSE frames.

    provider_kind selects the tool loop; event_format='v2' wraps the legacy
    openai-chunk stream in the V2 Event Stream protocol. on_context receives
    the final Branch Context state for persistence."""
    kind = request.provider_kind
    if kind in _OPENAI_FAMILY_KINDS:
        source = _stream_chat_with_tools(request.target, request.headers, request.payload, on_complete=on_context)
    elif kind == "anthropic":
        source = _stream_anthropic_with_tools(request.target, request.headers, request.payload, on_complete=on_context)
    else:
        source = _stream_responses_with_tools(request.target, request.headers, request.payload, on_complete=on_context)
    if event_format == "v2":
        return normalize_v2_stream(source, candidate_id)
    return source


async def complete_chat_completion(request: ChatRequest, *, candidate_id: str, event_format: str = "legacy", on_context=None) -> dict:
    """Complete one chat turn without streaming.

    Returns the response payload shaped for the requested event_format. The
    payload carries tools only when the web tool was requested
    (build_chat_request invariant), which selects the tool-loop path. Raises
    UpstreamError for HTTP-level provider errors; other exceptions mean a
    failed tool round and map to a 400 at the route."""
    import httpx

    kind = request.provider_kind
    payload = request.payload
    if payload.get("tools"):
        if kind in _OPENAI_FAMILY_KINDS:
            result = await _complete_with_chat_tools(request.target, request.headers, payload)
        elif kind == "anthropic":
            raw_payload = await _complete_with_anthropic_tools(request.target, request.headers, payload)
            state = raw_payload.pop("_context_state", {})
            result = normalize_non_stream_response(kind, raw_payload)
            result["_context_state"] = state
        else:
            raw_payload = await _complete_with_responses_tools(request.target, request.headers, payload)
            state = raw_payload.pop("_context_state", {})
            result = normalize_non_stream_response(kind, raw_payload)
            result["_context_state"] = state
    else:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(request.target, content=body, headers=request.headers)
        if resp.status_code >= 400:
            raise UpstreamError(resp.status_code, resp.text)
        raw_payload = resp.json()
        if kind in _OPENAI_FAMILY_KINDS:
            result = raw_payload
            message = result.get("choices", [{}])[0].get("message", {})
            # The request payload, not the provider response, owns the prior messages.
            state = {"kind": "chat_messages", "messages": [*json.loads(body.decode("utf-8")).get("messages", []), message]}
        elif kind == "anthropic":
            result = normalize_non_stream_response(kind, raw_payload)
            state = {
                "kind": "anthropic_messages",
                "messages": [*json.loads(body.decode("utf-8")).get("messages", []), {"role": "assistant", "content": raw_payload.get("content", [])}],
            }
        else:
            result = normalize_non_stream_response(kind, raw_payload)
            state = {"kind": "responses", "previous_response_id": raw_payload.get("id")}
        result["_context_state"] = state
    context_state = result.pop("_context_state", {})
    if context_state and on_context:
        on_context(context_state)
    message = result.get("choices", [{}])[0].get("message", {})
    if event_format == "v2":
        return {
            "candidate_id": candidate_id,
            "content": message.get("content") or "",
            "reasoning": message.get("reasoning_content") or "",
            "tool_events": result.get("tool_events") or [],
            "finish_reason": result.get("choices", [{}])[0].get("finish_reason") or "stop",
        }
    result["candidate_id"] = candidate_id
    return result
