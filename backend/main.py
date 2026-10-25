"""FastAPI main application — routes and WebSocket."""
from __future__ import annotations
import asyncio
import base64
import binascii
import io
import json
import os
from pathlib import Path
import time
import uuid
from contextlib import asynccontextmanager
import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from .models import AppConfig
from pypdf import PdfReader
from . import config_manager as cfg
from . import provider_manager as providers
from . import search_manager
from .process_manager import process_manager
from .update_manager import update_manager
from .download_manager import download_manager
from .chat_state import CandidateContext, conversation_store
from .storage import database
from .routers.conversations import router as conversations_router
from .moss_server import db as moss_db
from .moss_server.api import router as moss_api_router
from .moss_server.skills import load_skills as moss_load_skills, router as moss_skills_router
# Interim bridge while the chat adapter layer migrates into chat_adapters;
# shrinks to the deep interface as slices land.
from .chat_adapters import (
    _complete_with_anthropic_tools,
    _complete_with_chat_tools,
    _complete_with_responses_tools,
    _execute_chat_tool_calls,
    _force_web_search_tool_choice,
    _looks_like_missed_web_search,
    _merge_tool_call_delta,
    _openai_chunk,
    _run_web_search_tool,
    _stream_anthropic_with_tools,
    _stream_chat_with_tools,
    _stream_responses_with_tools,
    _tool_event_chunk,
    _tool_summary,
    build_chat_request,
    local_base_url,
    messages_with_web_tool_guidance,
    normalize_non_stream_response as _normalize_non_stream_response,
    normalize_v2_stream as _normalize_v2_stream,
    parse_dsml_tool_calls as _parse_dsml_tool_calls,
    provider_headers,
    provider_models_url,
    strip_dsml_tool_blocks as _strip_dsml_tool_blocks,
)


@asynccontextmanager
async def lifespan(application: FastAPI):
    await database.initialize()
    moss_db.init()
    moss_load_skills()
    client = httpx.AsyncClient(follow_redirects=False)
    from .process_manager import reap_orphan_engines
    orphans = await asyncio.to_thread(reap_orphan_engines)
    if orphans:
        print(f"[startup] reaped orphan engine processes: {orphans}", flush=True)
    cfg.load_config(cfg.initial_profile_name())
    application.state.db = database
    application.state.http_client = client
    try:
        yield
    finally:
        await client.aclose()


app = FastAPI(title="llama.cpp Run Manager", version="2.0.0", lifespan=lifespan)
app.include_router(conversations_router)
app.include_router(moss_api_router)
app.include_router(moss_skills_router)

def _error_payload(request: Request, code: str, message: str, details: dict | None = None) -> dict:
    return {
        "code": code,
        "message": message,
        "details": details or {},
        "request_id": getattr(request.state, "request_id", ""),
    }


@app.exception_handler(KeyError)
async def not_found_error(request: Request, exc: KeyError):
    return JSONResponse(status_code=404, content=_error_payload(request, "not_found", str(exc).strip("'")))


@app.exception_handler(ValueError)
async def validation_error(request: Request, exc: ValueError):
    return JSONResponse(status_code=400, content=_error_payload(request, "invalid_request", str(exc)))


FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


def _remote_api_enabled() -> bool:
    return os.getenv("LLAMA_MANAGER_ALLOW_REMOTE", "").lower() in {"1", "true", "yes", "on"}


def _is_local_host(host: str | None) -> bool:
    return host in {"127.0.0.1", "::1", "localhost", "testclient"} or (host or "").startswith("127.")


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


@app.middleware("http")
async def local_only_api(request: Request, call_next):
    request.state.request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex
    if request.url.path.startswith("/api/") and not _remote_api_enabled():
        if not _is_local_host(request.client.host if request.client else None):
            return JSONResponse(status_code=403, content=_error_payload(request, "remote_api_disabled", "Remote API access is disabled"))
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    return response


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
    # Save under the current profile name — "save current" must not silently
    # re-file the config into the default profile (compile flow relies on this).
    path = cfg.save_config(config, cfg.get_current_name())
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


# ── Model profiles ────────────────────────────────────────────

@app.get("/api/profiles")
def list_profiles():
    running = process_manager.get_status()
    profiles = []
    for name in cfg.list_configs():
        profile = cfg.read_config(name)
        if profile is None:
            continue
        summary = _profile_summary(name, profile)
        summary["is_running"] = running.state == "running" and running.profile == name
        profiles.append(summary)
    profiles.sort(key=lambda item: (not item["is_running"], not item["is_current"], item["name"]))
    return {"profiles": profiles}


def _profile_summary(name: str, profile: AppConfig) -> dict:
    model_path = Path(profile.model_path) if profile.model_path else None
    model_exists = bool(model_path and model_path.is_file())
    model_size_mb = 0.0
    if model_exists:
        model_size_mb = round(model_path.stat().st_size / (1024 * 1024), 1)
    basic = profile.basic
    kvmem = profile.kvmem
    ninfer = profile.ninfer
    thinking = kvmem.enable_thinking if profile.engine == "kvmem" else basic.enable_thinking
    return {
        "name": name,
        "is_current": cfg.get_current_name() == name,
        "engine": profile.engine,
        "thinking": thinking,
        "chat_template_file": profile.chat_template_file,
        "model_path": profile.model_path,
        "model_name": model_path.name if model_path else "",
        "model_size_mb": model_size_mb,
        "model_exists": model_exists,
        "model_meta": cfg.read_model_metadata(profile.model_path),
        "ctx_size": basic.ctx_size,
        "kvmem": {
            "workspace": kvmem.workspace,
            "budget": kvmem.budget,
            "gen_reserve": kvmem.gen_reserve,
            "kv_dtype": kvmem.kv_dtype,
            "enable_thinking": kvmem.enable_thinking,
            "sink_tokens": kvmem.sink_tokens,
            "recent_tokens": kvmem.recent_tokens,
            "lrfu": kvmem.lrfu,
            "score_agg": kvmem.score_agg,
        },
        "ninfer": {
            "max_context": ninfer.max_context,
            "budget": ninfer.budget,
            "gen_reserve": ninfer.gen_reserve,
            "prefill_chunk": ninfer.prefill_chunk,
            "cuda_graph": ninfer.cuda_graph,
            "host_kv_mib": ninfer.host_kv_mib,
            "kv_dtype": ninfer.kv_dtype,
            "spec": ninfer.spec,
            "draft_tokens": ninfer.draft_tokens,
            "sink_tokens": ninfer.sink_tokens,
            "recent_tokens": ninfer.recent_tokens,
            "lrfu": ninfer.lrfu,
            "score_agg": ninfer.score_agg,
        },

        "ngl": basic.ngl if basic.ngl_enabled else 0,
        "fit_enabled": basic.fit_enabled,
        "n_cpu_moe": basic.n_cpu_moe,
        "kv_cache_quant_k": basic.kv_cache_quant_k,
        "kv_cache_quant_v": basic.kv_cache_quant_v,
        "flash_attn": basic.flash_attn,
        "mtp_enabled": profile.mtp.enabled,
        "host": profile.server.host,
        "port": profile.server.port,
    }


@app.get("/api/profiles/current")
def current_profile():
    return {"name": cfg.get_current_name()}


@app.post("/api/profiles/set-current")
def set_current_profile(body: dict):
    raw_name = str(body.get("name", "")).strip()
    name = cfg._sanitize_name(raw_name)
    if not raw_name:
        return JSONResponse(status_code=400, content={"error": "Profile name is required"})
    if cfg.read_config(name) is None:
        return JSONResponse(status_code=404, content={"error": f"Profile not found: {name}"})
    cfg.load_config(name)
    return {"ok": True, "name": name}


@app.post("/api/profiles/duplicate")
def duplicate_profile(body: dict):
    raw_name = str(body.get("name", "")).strip()
    source = cfg._sanitize_name(body.get("source", "default"))
    name = cfg._sanitize_name(raw_name)
    # _sanitize_name falls back to "default" on empty input; an explicitly empty
    # name must be rejected instead of silently cloning into the default profile.
    if not raw_name or not name:
        raise ValueError("Profile name is required")
    try:
        path = cfg.duplicate_config(source, name)
    except FileNotFoundError as exc:
        return JSONResponse(status_code=404, content={"error": str(exc)})
    return {"ok": True, "path": str(path)}


@app.post("/api/profiles/launch")
async def launch_profile(request: Request, body: dict):
    raw_name = str(body.get("name", "")).strip()
    name = cfg._sanitize_name(raw_name)
    if not raw_name:
        return JSONResponse(status_code=400, content={"error": "Profile name is required"})
    profile = cfg.read_config(name)
    if profile is None:
        return JSONResponse(status_code=404, content={"error": f"Profile not found: {name}"})
    was_running = process_manager.get_status().state == "running"
    if was_running:
        await process_manager.stop()
    try:
        await process_manager.start(profile, profile_name=name)
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    cfg.load_config(name)
    return {"ok": True, "restarted": was_running, "profile": name}


# ── Chat attachments ──────────────────────────────────────────

MAX_ATTACHMENT_CHARS = 150_000
MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024


@app.post("/api/attachments/extract")
async def extract_attachment(request: Request):
    """Extract text from an uploaded chat attachment (PDF via pypdf, else UTF-8)."""
    body = await request.json()
    name = str(body.get("name") or "attachment")
    data_base64 = str(body.get("data_base64") or "")
    try:
        raw = base64.b64decode(data_base64, validate=True)
    except (binascii.Error, ValueError):
        return JSONResponse(status_code=400, content={"error": "附件数据不是有效的 base64"})
    if len(raw) > MAX_ATTACHMENT_BYTES:
        return JSONResponse(status_code=413, content={"error": f"文件超过 {MAX_ATTACHMENT_BYTES // (1024 * 1024)}MB 上限"})
    def _extract_sync() -> str:
        if name.lower().endswith(".pdf"):
            reader = PdfReader(io.BytesIO(raw))
            return "\n\n".join((page.extract_text() or "") for page in reader.pages)
        return raw.decode("utf-8", errors="replace")

    try:
        # pypdf is CPU-bound; keep it off the event loop so long PDFs do not
        # freeze websocket pushes and unrelated requests.
        text = await asyncio.to_thread(_extract_sync)
    except Exception as exc:
        return JSONResponse(status_code=422, content={"error": f"解析失败: {exc}"})
    truncated = len(text) > MAX_ATTACHMENT_CHARS
    if truncated:
        text = text[:MAX_ATTACHMENT_CHARS] + "\n\n…[内容已截断]"
    return {"name": name, "size": len(raw), "chars": len(text), "truncated": truncated, "content": text}


@app.get("/api/scan-models")
def scan_models(dir: str):
    models = cfg.scan_models(dir)
    return {"models": [m.model_dump() for m in models]}


@app.get("/api/model-info")
def model_info(path: str):
    """Size + metadata for one model file — feeds the live VRAM/RAM estimator."""
    from pathlib import Path as _Path
    model_path = _Path(path) if path else None
    size_mb = round(model_path.stat().st_size / (1024 * 1024), 1) if model_path and model_path.is_file() else 0
    return {"size_mb": size_mb, "meta": cfg.read_model_metadata(path)}


@app.get("/api/detect-server")
def detect_server(llama_cpp_dir: str, engine: str = "llama.cpp"):
    resolved = cfg.resolve_engine_dir(llama_cpp_dir, engine)
    if engine == "kvmem":
        path = cfg.detect_kvmem_binary(resolved)
    elif engine == "ninfer":
        path = cfg.detect_ninfer_binary(resolved)
    else:
        path = cfg.detect_server_binary(resolved)
    return {
        "path": path,
        "found": bool(path),
        "dir": resolved,
        "bundled": not (llama_cpp_dir or "").strip(),
        # Lets the form grey out parameters this build predates instead of
        # letting the launch die on "unknown flag".
        "lrfu": "--kvmem-lrfu" in cfg.binary_flags(path) if path else False,
    }



# ── Server control endpoints ──────────────────────────────────

@app.post("/api/server/start")
async def server_start():
    try:
        config = cfg.get_config()
        await process_manager.start(config, profile_name=cfg.get_current_name())
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
    url = f"{local_base_url(config)}/health"
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

MIRROR_CANDIDATES = [
    {"id": "github", "name": "GitHub 直连", "prefix": ""},
    {"id": "ghproxy", "name": "ghproxy.net", "prefix": "https://ghproxy.net/https://github.com"},
    {"id": "gh-proxy", "name": "gh-proxy.com", "prefix": "https://gh-proxy.com/https://github.com"},
    {"id": "ghfast", "name": "ghfast.top", "prefix": "https://ghfast.top/https://github.com"},
    {"id": "moeyy", "name": "moeyy.xyz", "prefix": "https://github.moeyy.xyz/https://github.com"},
]


@app.get("/api/mirrors")
async def probe_mirrors():
    """Probe each candidate's git smart-HTTP handshake endpoint; rank by latency."""
    import httpx
    probe_path = "/ggml-org/llama.cpp.git/info/refs?service=git-upload-pack"

    async def probe(candidate: dict) -> dict:
        url = (candidate["prefix"] + "/https://github.com" if candidate["prefix"] else "https://github.com") + probe_path
        t0 = time.perf_counter()
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=8) as client:
                resp = await client.get(url)
            latency = int((time.perf_counter() - t0) * 1000)
            ok = resp.status_code == 200 and "git-upload-pack" in resp.headers.get("content-type", "")
            return {**candidate, "ok": ok, "latency_ms": latency if ok else None}
        except Exception:
            return {**candidate, "ok": False, "latency_ms": None}

    results = await asyncio.gather(*(probe(c) for c in MIRROR_CANDIDATES))
    return {"mirrors": sorted(results, key=lambda m: (not m["ok"], m["latency_ms"] if m["latency_ms"] is not None else 10**9))}


@app.get("/api/update/check")
async def update_check(mirror: str = ""):
    config = cfg.get_config()
    if not config.llama_cpp_dir:
        return JSONResponse(status_code=400, content={"error": "llama.cpp directory not set"})
    return await update_manager.check_update(config.llama_cpp_dir, mirror_prefix=mirror)


@app.post("/api/update/pull")
async def update_pull(request: Request):
    config = cfg.get_config()
    if not config.llama_cpp_dir:
        return JSONResponse(status_code=400, content={"error": "llama.cpp directory not set"})
    body = await request.json() if request.headers.get("content-type","") == "application/json" else {}
    force = body.get("force", False)
    mirror = str(body.get("mirror", "") or "")
    return await update_manager.pull_update(config.llama_cpp_dir, mirror_prefix=mirror, force=force)


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
    messages = messages_with_web_tool_guidance(messages, use_web_tool)
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

    if provider_config and not provider_config.enabled:
        return JSONResponse(status_code=409, content={"error": f"Provider is disabled: {provider_config.name}"})
    try:
        chat_request = build_chat_request(provider_config=provider_config, config=config, data=data, messages=messages)
    except RuntimeError as exc:
        return JSONResponse(status_code=409, content={"error": str(exc)})
    provider_kind = chat_request.provider_kind
    payload = chat_request.payload

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
            source = _stream_chat_with_tools(chat_request.target, chat_request.headers, payload, on_complete=save_context)
        elif provider_kind == "anthropic":
            source = _stream_anthropic_with_tools(chat_request.target, chat_request.headers, payload, on_complete=save_context)
        else:
            source = _stream_responses_with_tools(chat_request.target, chat_request.headers, payload, on_complete=save_context)
        if event_format == "v2":
            source = _normalize_v2_stream(source, candidate_id)
        return StreamingResponse(source, media_type="text/event-stream")

    if use_web_tool:
        try:
            if provider_kind in {"deepseek", "openai_chat", "openai_compatible"}:
                payload = await _complete_with_chat_tools(chat_request.target, chat_request.headers, payload)
            elif provider_kind == "anthropic":
                raw_payload = await _complete_with_anthropic_tools(chat_request.target, chat_request.headers, payload)
                state = raw_payload.pop("_context_state", {})
                payload = _normalize_non_stream_response(provider_kind, raw_payload)
                payload["_context_state"] = state
            else:
                raw_payload = await _complete_with_responses_tools(chat_request.target, chat_request.headers, payload)
                state = raw_payload.pop("_context_state", {})
                payload = _normalize_non_stream_response(provider_kind, raw_payload)
                payload["_context_state"] = state
        except Exception as exc:
            return JSONResponse(status_code=400, content={"error": str(exc)})
    else:
        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(chat_request.target, content=body, headers=chat_request.headers)
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
    target = f"{local_base_url(config)}/v1/models"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(target)
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=502)


@app.get("/api/chat/providers")
async def chat_providers():
    return {"providers": [{"id": "local", "name": "本地引擎", "kind": "local", "configured": True, "engine": cfg.get_config().engine}, *providers.list_providers()]}


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
        headers = provider_headers(provider)
        target = provider_models_url(provider)
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


# ── Static files ──────────────────────────────────────────────

@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")
