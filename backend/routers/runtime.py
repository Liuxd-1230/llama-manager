from __future__ import annotations
import httpx
from ..responses import JSONResponse
from .. import config_manager as cfg
from .. import resources
from ..process_manager import process_manager

from fastapi import APIRouter
from ..inference import _local_base_url
router = APIRouter(tags=["runtime"])
_suspended_profile: str | None = None

@router.post("/api/v1/server/start")
async def server_start():
    try:
        config = cfg.get_config()
        await process_manager.start(config, profile_name=cfg.get_current_name())
        return {"ok": True}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})


@router.post("/api/v1/server/stop")
async def server_stop():
    await process_manager.stop()
    return {"ok": True}


@router.get("/api/v1/server/status")
def server_status():
    return process_manager.get_status().model_dump()


@router.get("/api/v1/host/resources")
def host_resources():
    """Live host RAM/VRAM for the top bar (degrades to nulls, never errors)."""
    return resources.read_resources()


@router.post("/api/v1/server/suspend")
async def server_suspend():
    """Pause: stop the engine, remembering the profile so resume can relaunch it."""
    global _suspended_profile
    status = process_manager.get_status()
    if status.state == "running":
        _suspended_profile = status.profile or cfg.get_current_name()
        await process_manager.stop()
    return {"ok": True, "profile": _suspended_profile}


@router.post("/api/v1/server/resume")
async def server_resume(body: dict | None = None):
    """Resume: relaunch the remembered profile (or the one named in the body)."""
    name = str((body or {}).get("profile") or _suspended_profile or cfg.get_current_name() or "").strip()
    if not name:
        return JSONResponse(status_code=400, content={"error": "没有可恢复的档案"})
    profile = cfg.read_config(name)
    if profile is None:
        return JSONResponse(status_code=404, content={"error": f"档案不存在：{name}"})
    if process_manager.get_status().state == "running":
        return {"ok": True, "profile": name, "already_running": True}
    try:
        await process_manager.start(profile, profile_name=name)
    except (ValueError, RuntimeError) as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    return {"ok": True, "profile": name}


@router.get("/api/v1/server/health")
async def server_health():
    """Check if llama-server is accepting requests."""
    config = cfg.get_config()
    url = f"{_local_base_url(config)}/health"
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            resp = await client.get(url)
            return {"ready": resp.status_code == 200, "status": resp.status_code}
    except Exception:
        return {"ready": False, "status": "unreachable"}


@router.get("/api/v1/server/summary")
def server_summary():
    """One poll for the top bar: engine state plus host RAM/VRAM readouts."""
    return {"server": process_manager.get_status().model_dump(), "resources": resources.read_resources()}


@router.get("/api/v1/server/logs")
def server_logs():
    return {"logs": process_manager.get_logs()}


@router.post("/api/v1/server/logs/clear")
def clear_logs():
    process_manager.clear_logs()
    return {"ok": True}
