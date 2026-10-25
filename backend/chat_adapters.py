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
