"""FastAPI main application — routes and WebSocket."""
from __future__ import annotations
import asyncio
import ipaddress
import json
import os
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from .models import AppConfig
from . import config_manager as cfg
from . import provider_manager as providers
from .process_manager import process_manager
from .update_manager import update_manager
from .download_manager import download_manager
from .optimizer import optimizer

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
    env_by_kind = {
        "deepseek": "DEEPSEEK_API_KEY",
        "openai_chat": "OPENAI_API_KEY",
        "openai_responses": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
    }
    return provider.api_key.strip() or os.getenv(env_by_kind.get(provider.kind, ""), "").strip()


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


def _public_http_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    if host in {"localhost", "0.0.0.0"} or host.endswith(".local"):
        return False
    try:
        ip = ipaddress.ip_address(host)
        return not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved)
    except ValueError:
        return True


class _DuckDuckGoParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.results: list[dict[str, str]] = []
        self._href = ""
        self._title: list[str] = []
        self._in_result = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = attrs.get("class", "")
        if tag == "a" and "result__a" in classes:
            self._href = attrs.get("href", "")
            self._title = []
            self._in_result = True

    def handle_data(self, data):
        if self._in_result:
            self._title.append(data)

    def handle_endtag(self, tag):
        if tag != "a" or not self._in_result:
            return
        title = " ".join("".join(self._title).split())
        url = self._href
        if "uddg=" in url:
            url = unquote(parse_qs(urlparse(url).query).get("uddg", [url])[0])
        if title and _public_http_url(url):
            self.results.append({"title": title, "url": url})
        self._href = ""
        self._title = []
        self._in_result = False


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag in {"script", "style", "noscript", "svg"} and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data):
        if not self._skip_depth:
            text = " ".join(data.split())
            if text:
                self.parts.append(text)


async def _search_web(query: str, limit: int = 4) -> list[dict[str, str]]:
    import httpx
    if not query.strip():
        return []
    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        resp = await client.get(
            "https://duckduckgo.com/html/",
            params={"q": query},
            headers={"User-Agent": "llama-manager/1.0"},
        )
        resp.raise_for_status()
        parser = _DuckDuckGoParser()
        parser.feed(resp.text)
        results = parser.results[:limit]
        for item in results[:3]:
            try:
                if not _public_http_url(item["url"]):
                    continue
                page = await client.get(item["url"], headers={"User-Agent": "llama-manager/1.0"})
                if "text/html" not in page.headers.get("content-type", ""):
                    continue
                extractor = _TextExtractor()
                extractor.feed(page.text[:250_000])
                item["snippet"] = " ".join(extractor.parts)[:1200]
            except Exception:
                item["snippet"] = ""
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


def _local_chat_payload(data: dict, config: AppConfig, messages: list[dict]) -> dict:
    sampling = config.sampling
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


def _anthropic_web_search_tool_schema() -> dict:
    fn = _web_search_tool_schema()["function"]
    return {"name": fn["name"], "description": fn["description"], "input_schema": fn["parameters"]}


async def _run_web_search_tool(arguments: dict) -> str:
    query = str(arguments.get("query", "")).strip()
    limit = int(arguments.get("limit") or 4)
    results = await _search_web(query, limit=max(1, min(limit, 5)))
    if not results:
        return "No web results found."
    lines = []
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
    return {"choices": [{"message": message}], "raw": payload}


async def _complete_with_chat_tools(target: str, headers: dict[str, str], payload: dict, max_rounds: int = 3) -> dict:
    import httpx
    tool_payload = dict(payload)
    tool_payload["stream"] = False
    async with httpx.AsyncClient(timeout=300) as client:
        messages = [*tool_payload.get("messages", [])]
        last_payload = None
        for _ in range(max_rounds):
            request_payload = dict(tool_payload)
            request_payload["messages"] = messages
            resp = await client.post(target, json=request_payload, headers=headers)
            resp.raise_for_status()
            last_payload = resp.json()
            message = last_payload.get("choices", [{}])[0].get("message", {})
            tool_calls = message.get("tool_calls") or []
            if not tool_calls:
                return last_payload
            messages.append(message)
            for call in tool_calls:
                fn = call.get("function", {})
                if fn.get("name") != "web_search":
                    result = f"Unsupported tool: {fn.get('name')}"
                else:
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                        result = await _run_web_search_tool(args)
                    except Exception as exc:
                        result = f"web_search failed: {exc}"
                messages.append({"role": "tool", "tool_call_id": call.get("id"), "content": result})
        final_payload = dict(tool_payload)
        final_payload["messages"] = messages
        final_payload.pop("tools", None)
        final_payload.pop("tool_choice", None)
        final = await client.post(target, json=final_payload, headers=headers)
        final.raise_for_status()
        return final.json() if last_payload is not None else {}


async def _complete_with_anthropic_tools(target: str, headers: dict[str, str], payload: dict, max_rounds: int = 3) -> dict:
    import httpx
    tool_payload = dict(payload)
    tool_payload["stream"] = False
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
                return last_payload
            messages.append({"role": "assistant", "content": last_payload.get("content", [])})
            tool_results = []
            for use in uses:
                if use.get("name") != "web_search":
                    result = f"Unsupported tool: {use.get('name')}"
                else:
                    try:
                        result = await _run_web_search_tool(use.get("input") or {})
                    except Exception as exc:
                        result = f"web_search failed: {exc}"
                tool_results.append({"type": "tool_result", "tool_use_id": use.get("id"), "content": result})
            messages.append({"role": "user", "content": tool_results})
        final_payload = dict(tool_payload)
        final_payload["messages"] = messages
        final_payload.pop("tools", None)
        final = await client.post(target, json=final_payload, headers=headers)
        final.raise_for_status()
        return final.json() if last_payload is not None else {}


async def _complete_with_responses_tools(target: str, headers: dict[str, str], payload: dict, max_rounds: int = 3) -> dict:
    import httpx
    tool_payload = dict(payload)
    tool_payload["stream"] = False
    async with httpx.AsyncClient(timeout=300) as client:
        request_payload = tool_payload
        last_payload = None
        for _ in range(max_rounds):
            resp = await client.post(target, json=request_payload, headers=headers)
            resp.raise_for_status()
            last_payload = resp.json()
            calls = [item for item in last_payload.get("output", []) if item.get("type") == "function_call"]
            if not calls:
                return last_payload
            tool_outputs = []
            for call in calls:
                if call.get("name") != "web_search":
                    result = f"Unsupported tool: {call.get('name')}"
                else:
                    try:
                        result = await _run_web_search_tool(json.loads(call.get("arguments") or "{}"))
                    except Exception as exc:
                        result = f"web_search failed: {exc}"
                tool_outputs.append({"type": "function_call_output", "call_id": call.get("call_id"), "output": result})
            request_payload = {
                "model": tool_payload.get("model"),
                "input": tool_outputs,
                "previous_response_id": last_payload.get("id"),
                "stream": False,
                "tools": tool_payload.get("tools", []),
            }
        final_payload = dict(request_payload)
        final_payload.pop("tools", None)
        final = await client.post(target, json=final_payload, headers=headers)
        final.raise_for_status()
        return final.json() if last_payload is not None else {}


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
    """Proxy chat requests to local llama-server or DeepSeek."""
    import httpx
    config = cfg.get_config()
    data = await request.json()
    provider_id = data.get("provider", "local")
    messages = data.get("messages", [])
    use_web_tool = bool(data.get("web_search_tool") or data.get("web_search") is True)
    messages = await _messages_with_search_context(messages, bool(data.get("search_summary")))
    stream = bool(data.get("stream", True))

    provider_config = None
    if provider_id not in {"local", "deepseek-api"}:
        provider_config = providers.get_provider(provider_id)

    if provider_id == "deepseek-api" and not provider_config:
        provider_config = providers.get_provider("deepseek")

    if provider_config:
        try:
            headers = _provider_headers(provider_config)
        except RuntimeError as exc:
            return JSONResponse(status_code=400, content={"error": str(exc)})
        target, payload = _external_chat_request(provider_config, data, messages)
    else:
        target = f"http://{config.server.host}:{config.server.port}/v1/chat/completions"
        headers = {"Content-Type": "application/json"}
        payload = _local_chat_payload(data, config, messages)

    try:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    except TypeError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})

    if provider_config and use_web_tool:
        try:
            if provider_config.kind in {"deepseek", "openai_chat", "openai_compatible"}:
                payload = await _complete_with_chat_tools(target, headers, payload)
            elif provider_config.kind == "anthropic":
                payload = _normalize_non_stream_response(provider_config.kind, await _complete_with_anthropic_tools(target, headers, payload))
            elif provider_config.kind == "openai_responses":
                payload = _normalize_non_stream_response(provider_config.kind, await _complete_with_responses_tools(target, headers, payload))
        except Exception as exc:
            return JSONResponse(status_code=400, content={"error": str(exc)})
        if stream:
            message = payload.get("choices", [{}])[0].get("message", {})
            return StreamingResponse(
                iter([_openai_chunk(content=message.get("content") or "", reasoning=message.get("reasoning_content") or ""), "data: [DONE]\n\n"]),
                media_type="text/event-stream",
            )
        return JSONResponse(content=payload)

    if stream:
        async def generate():
            try:
                async with httpx.AsyncClient(timeout=300) as client:
                    async with client.stream("POST", target, content=body, headers=headers) as resp:
                        if resp.status_code >= 400:
                            error_text = await resp.aread()
                            yield (
                                "data: "
                                + json.dumps({"error": error_text.decode("utf-8", errors="replace")})
                                + "\n\n"
                            )
                            yield "data: [DONE]\n\n"
                            return
                        if provider_config and provider_config.kind not in {"deepseek", "openai_chat", "openai_compatible"}:
                            async for line in resp.aiter_lines():
                                if not line.startswith("data: "):
                                    continue
                                data_text = line[6:].strip()
                                if data_text == "[DONE]":
                                    yield "data: [DONE]\n\n"
                                    continue
                                try:
                                    normalized = _normalize_external_sse(provider_config.kind, json.loads(data_text))
                                except Exception:
                                    normalized = ""
                                if normalized:
                                    yield normalized
                            yield "data: [DONE]\n\n"
                        else:
                            async for chunk in resp.aiter_bytes():
                                yield chunk
            except Exception as exc:
                yield "data: " + json.dumps({"error": str(exc)}) + "\n\n"
                yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(target, content=body, headers=headers)
            payload = resp.json()
            if provider_config:
                payload = _normalize_non_stream_response(provider_config.kind, payload)
            return JSONResponse(content=payload, status_code=resp.status_code)


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
