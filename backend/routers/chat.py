from __future__ import annotations
import json
import time
import uuid
import httpx
from fastapi import Request
from fastapi.responses import StreamingResponse
from ..responses import JSONResponse
from .. import config_manager as cfg
from .. import provider_manager as providers
from .. import search_manager
from ..chat_state import CandidateContext, conversation_store

from fastapi import APIRouter
from ..inference import _local_base_url, _provider_headers, _provider_models_url, _messages_with_search_context, _messages_with_web_tool_guidance, _local_chat_payload, _external_chat_request, _normalize_non_stream_response, _complete_with_chat_tools, _stream_chat_with_tools, _complete_with_anthropic_tools, _complete_with_responses_tools, _stream_anthropic_with_tools, _stream_responses_with_tools, _normalize_v2_stream
router = APIRouter(tags=["chat"])

@router.post("/api/v1/chat")
async def chat_proxy(request: Request):
    """Proxy a chat turn while preserving provider-specific branch context."""

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
        target = f"{_local_base_url(config)}/v1/chat/completions"
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
        if provider_kind in {"openai_chat"}:
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
            if provider_kind in {"openai_chat"}:
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
        try:
            async with httpx.AsyncClient(timeout=300) as client:
                resp = await client.post(target, content=body, headers=headers)
        except httpx.HTTPError as exc:
            # 引擎宕机要给出可操作的错误，而不是把连接异常裸穿成 400/500。
            hint = "本地引擎未运行，请先在「模型」页启动引擎" if provider_config is None else "上游模型服务无法连接"
            return JSONResponse(status_code=502, content={"error": f"{hint}: {exc}"})
        if resp.status_code >= 400:
            # 上游可能是本机其它服务（端口被占用时），原文返回状态码与截断正文。
            return JSONResponse(status_code=resp.status_code, content={"error": resp.text[:400] or f"HTTP {resp.status_code}"})
        raw_payload = resp.json()
        if provider_kind in {"openai_chat"}:
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


@router.delete("/api/v1/chat/conversations/{conversation_id}")
async def clear_chat_conversation(conversation_id: str):
    conversation_store.delete(conversation_id)
    return {"ok": True}


@router.get("/api/v1/chat/models")
async def list_models(provider: str = "local"):
    """List local or DeepSeek models."""
    provider_config = providers.get_provider(provider)
    if provider_config:
        return {"data": [{"id": model} for model in provider_config.models]}
    config = cfg.get_config()
    target = f"{_local_base_url(config)}/v1/models"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(target)
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=502)


@router.get("/api/v1/chat/providers")
async def chat_providers():
    return {"providers": [{"id": "local", "name": "本地引擎", "kind": "local", "configured": True, "engine": cfg.get_config().engine}, *providers.list_providers()]}


@router.get("/api/v1/search/settings")
async def get_search_settings():
    return search_manager.public_settings()


@router.put("/api/v1/search/settings")
async def put_search_settings(body: dict):
    try:
        return search_manager.save_settings(body)
    except Exception as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@router.post("/api/v1/chat/providers")
async def save_chat_provider(body: dict):
    try:
        return providers.save_provider(body)
    except Exception as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@router.delete("/api/v1/chat/providers/{provider_id}")
async def delete_chat_provider(provider_id: str):
    if providers.delete_provider(provider_id):
        return {"ok": True}
    return JSONResponse(status_code=404, content={"error": "Provider not found or cannot be deleted"})


@router.post("/api/v1/chat/providers/{provider_id}/models")
async def fetch_provider_models(provider_id: str):
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
