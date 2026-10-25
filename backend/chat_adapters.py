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
