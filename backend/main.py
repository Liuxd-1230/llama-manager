"""FastAPI main application — routes and WebSocket."""
from __future__ import annotations
import asyncio
import json
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from .models import AppConfig
from . import config_manager as cfg
from .process_manager import process_manager
from .update_manager import update_manager
from .download_manager import download_manager
from .optimizer import optimizer

app = FastAPI(title="llama.cpp Run Manager")

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


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
    name = body.get("name", "default")
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


# ── Chat proxy to llama-server ──────────────────────────────

@app.post("/api/chat")
async def chat_proxy(request: Request):
    """Proxy chat requests to the local llama-server's /v1/chat/completions."""
    import httpx
    config = cfg.get_config()
    body = await request.body()
    target = f"http://{config.server.host}:{config.server.port}/v1/chat/completions"

    stream = False
    try:
        data = json.loads(body)
        stream = data.get("stream", False)
    except Exception:
        pass

    headers = {"Content-Type": "application/json"}

    if stream:
        async def generate():
            async with httpx.AsyncClient(timeout=300) as client:
                async with client.stream("POST", target, content=body, headers=headers) as resp:
                    async for chunk in resp.aiter_bytes():
                        yield chunk
        return StreamingResponse(generate(), media_type="text/event-stream")
    else:
        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(target, content=body, headers=headers)
            return JSONResponse(content=resp.json(), status_code=resp.status_code)


@app.get("/api/chat/models")
async def list_models():
    """Proxy model list from llama-server."""
    import httpx
    config = cfg.get_config()
    target = f"http://{config.server.host}:{config.server.port}/v1/models"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(target)
            return JSONResponse(content=resp.json(), status_code=resp.status_code)
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=502)


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
    body = await request.json()
    config = cfg.get_config()
    try:
        await optimizer.run_optimization(
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
            fit_target=config.basic.fit_target,
        )
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
