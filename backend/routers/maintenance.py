from __future__ import annotations
import asyncio
import time
import httpx
from fastapi import WebSocket, WebSocketDisconnect, Request
from ..responses import JSONResponse
from .. import config_manager as cfg
from ..process_manager import process_manager
from ..update_manager import update_manager

from fastapi import APIRouter
from ..inference import _reject_remote_websocket
MIRROR_CANDIDATES = [
    {"id": "github", "name": "GitHub 直连", "prefix": ""},
    {"id": "ghproxy", "name": "ghproxy.net", "prefix": "https://ghproxy.net/https://github.com"},
    {"id": "gh-proxy", "name": "gh-proxy.com", "prefix": "https://gh-proxy.com/https://github.com"},
    {"id": "ghfast", "name": "ghfast.top", "prefix": "https://ghfast.top/https://github.com"},
    {"id": "moeyy", "name": "moeyy.xyz", "prefix": "https://github.moeyy.xyz/https://github.com"},
]

router = APIRouter(tags=["maintenance"])

@router.get("/api/v1/mirrors")
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


@router.get("/api/v1/update/check")
async def update_check(mirror: str = ""):
    config = cfg.get_config()
    if not config.llama_cpp_dir:
        return JSONResponse(status_code=400, content={"error": "llama.cpp directory not set"})
    return await update_manager.check_update(config.llama_cpp_dir, mirror_prefix=mirror)


@router.post("/api/v1/update/pull")
async def update_pull(request: Request):
    config = cfg.get_config()
    if not config.llama_cpp_dir:
        return JSONResponse(status_code=400, content={"error": "llama.cpp directory not set"})
    body = await request.json() if request.headers.get("content-type","") == "application/json" else {}
    force = body.get("force", False)
    mirror = str(body.get("mirror", "") or "")
    return await update_manager.pull_update(config.llama_cpp_dir, mirror_prefix=mirror, force=force)


@router.post("/api/v1/update/compile")
async def update_compile():
    config = cfg.get_config()
    if not config.llama_cpp_dir:
        return JSONResponse(status_code=400, content={"error": "llama.cpp directory not set"})
    try:
        await update_manager.start_compile(config.llama_cpp_dir, config.compile.command)
        return {"ok": True}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@router.post("/api/v1/update/compile/stop")
async def compile_stop():
    await update_manager.stop()
    return {"ok": True}


@router.get("/api/v1/update/compile/logs")
def compile_logs():
    return {"logs": update_manager.get_compile_logs(), "is_compiling": update_manager.is_compiling()}


@router.websocket("/ws/logs")
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


@router.websocket("/ws/compile")
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
