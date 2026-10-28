from __future__ import annotations
from pathlib import Path
from fastapi import Request
from ..responses import JSONResponse
from ..models import AppConfig
from .. import config_manager as cfg
from ..process_manager import process_manager

from fastapi import APIRouter
router = APIRouter(tags=["models"])

@router.get("/api/v1/config")
def get_config():
    return cfg.get_config().model_dump()


@router.post("/api/v1/config")
def save_config(config: AppConfig):
    # Save under the current profile name — "save current" must not silently
    # re-file the config into the default profile (compile flow relies on this).
    path = cfg.save_config(config, cfg.get_current_name())
    return {"ok": True, "path": str(path)}


@router.post("/api/v1/config/save-as")
def save_config_as(body: dict):
    name = body.get("name", "default")
    config = AppConfig(**body.get("config", cfg.get_config().model_dump()))
    path = cfg.save_config(config, name)
    return {"ok": True, "path": str(path)}


@router.get("/api/v1/config/list")
def list_configs():
    return {"configs": cfg.list_configs()}


@router.post("/api/v1/config/load")
def load_config(body: dict):
    name = body.get("name", "default")
    config = cfg.load_config(name)
    return config.model_dump()


@router.post("/api/v1/config/delete")
def delete_config(body: dict):
    name = cfg._sanitize_name(body.get("name", "default"))
    if name == "default":
        return JSONResponse(status_code=400, content={"error": "Cannot delete default config"})
    path = cfg.CONFIG_DIR / f"{name}.json"
    if path.exists():
        path.unlink()
        return {"ok": True}
    return JSONResponse(status_code=404, content={"error": "Config not found"})


@router.post("/api/v1/config/import")
async def import_config(body: dict):
    content = body.get("content", "{}")
    config = cfg.import_config(content)
    return config.model_dump()


@router.get("/api/v1/profiles")
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


@router.get("/api/v1/profiles/current")
def current_profile():
    return {"name": cfg.get_current_name()}


@router.post("/api/v1/profiles/set-current")
def set_current_profile(body: dict):
    raw_name = str(body.get("name", "")).strip()
    name = cfg._sanitize_name(raw_name)
    if not raw_name:
        return JSONResponse(status_code=400, content={"error": "Profile name is required"})
    if cfg.read_config(name) is None:
        return JSONResponse(status_code=404, content={"error": f"Profile not found: {name}"})
    cfg.load_config(name)
    return {"ok": True, "name": name}


@router.post("/api/v1/profiles/duplicate")
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


@router.post("/api/v1/profiles/launch")
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
