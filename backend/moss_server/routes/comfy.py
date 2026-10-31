from __future__ import annotations

"""ComfyUI routes: workflow library, bindings, node graph and submission."""
import base64
import re
import time
import uuid
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import comfy
from .. import config
from ..config import (active_workflow, workflow_summaries, workflow_write)

router = APIRouter(prefix="/api/v1/moss")


class ComfyImportBody(BaseModel):
    workflow: str
    name: Optional[str] = None


class ComfyBindBody(BaseModel):
    bindings: dict[str, dict]
    workflow_id: Optional[str] = None


def _workflow_for(settings: dict, identifier: str | None) -> dict:
    if identifier is None:
        workflow = active_workflow(settings)
    else:
        workflow = (settings.get('comfy_workflows') or {}).get(identifier)
    if not workflow:
        raise HTTPException(status_code=404, detail='工作流不存在，请重新选择')
    return workflow


class ComfyGenerateBody(BaseModel):
    positive: str = ""
    negative: str = ""
    seed: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    cfg: Optional[float] = None
    sampler: Optional[str] = None
    scheduler: Optional[str] = None
    steps: Optional[int] = None


@router.post("/comfy/import")
@workflow_write
def comfy_import(body: ComfyImportBody):
    """Each reported phase corresponds to real work, with a durable audit trail."""
    from ...atelier import store
    task = store.create_job('workflow', body.name or '导入工作流', {'source':'api_import'})
    identifier = task['id']
    def phase(name): store.update_job(identifier,status='running',result={'phase':name})
    try:
        phase('parsing')
        nodes = comfy.parse_workflow(body.workflow)
        phase('building')
        suggested = comfy.guess_bindings(nodes)
        phase('validating')
        errors = [error for field,binding in suggested.items() if (error := comfy.validate_binding(nodes,field,binding))]
        if errors: raise comfy.ComfyError('绑定无效：'+'；'.join(errors))
        s = config.load_settings()
        name = (body.name or '').strip() or f"工作流 {len(s.get('comfy_workflows') or {}) + 1}"
        wid = uuid.uuid4().hex[:10]
        phase('saving')
        s.setdefault('comfy_workflows',{})[wid] = {'name':name,'nodes':nodes,'bindings':suggested,'layout':{},'params':{},'created_at':time.strftime('%Y-%m-%dT%H:%M:%S%z')}
        s['comfy_active'] = wid
        config.save_settings(s)
        store.update_job(identifier,status='succeeded',result={'phase':'completed','workflow_id':wid,'nodes':len(nodes)})
        return {'id':wid,'name':name,'job_id':identifier,'nodes':comfy.node_choices(nodes),'fields':comfy.FIELD_LABELS,'suggested':suggested,'workflows':workflow_summaries(s)}
    except comfy.ComfyError as exc:
        store.update_job(identifier,status='failed',result={'phase':'failed'},error=str(exc))
        raise HTTPException(status_code=400,detail=str(exc)) from exc
    except Exception:
        store.update_job(identifier,status='failed',result={'phase':'failed'},error='工作流未保存，请重试并检查日志')
        raise


@router.get("/comfy/workflows")
def comfy_workflows():
    s = config.load_settings()
    return {"workflows": workflow_summaries(s), "active_id": s.get("comfy_active") or ""}


@router.put("/comfy/workflows/active")
@workflow_write
def comfy_activate(body: dict):
    """Switch the active workflow. Bindings/layout travel with each workflow."""
    wid = str(body.get("id") or "")
    s = config.load_settings()
    workflows = s.get("comfy_workflows") or {}
    if wid not in workflows:
        raise HTTPException(status_code=404, detail="工作流不存在")
    s["comfy_active"] = wid
    config.save_settings(s)
    return {"active_id": wid, "workflows": workflow_summaries(s)}


@router.put("/comfy/workflows/{wid}")
@workflow_write
def comfy_rename(wid: str, body: dict):
    s = config.load_settings()
    wf = (s.get("comfy_workflows") or {}).get(wid)
    if not isinstance(wf, dict):
        raise HTTPException(status_code=404, detail="工作流不存在")
    name = str(body.get("name") or "").strip()
    if name:
        wf["name"] = name
    config.save_settings(s)
    return {"workflows": workflow_summaries(s)}


@router.delete("/comfy/workflows/{wid}")
@workflow_write
def comfy_delete_workflow(wid: str):
    s = config.load_settings()
    workflows = s.get("comfy_workflows") or {}
    if wid not in workflows:
        raise HTTPException(status_code=404, detail="工作流不存在")
    workflows.pop(wid)
    if s.get("comfy_active") == wid:
        s["comfy_active"] = next(iter(workflows), "")
    config.save_settings(s)
    return {"workflows": workflow_summaries(s), "active_id": s.get("comfy_active") or ""}


@router.put("/comfy/bindings")
@workflow_write
def comfy_bindings(body: ComfyBindBody):
    s = config.load_settings()
    clean = {}
    for field, binding in (body.bindings or {}).items():
        if field in comfy.FIELDS and isinstance(binding, dict) and binding.get("node"):
            clean[field] = {"node": str(binding["node"]), "input": str(binding.get("input") or "")}
    wf = _workflow_for(s, body.workflow_id)
    errors = [error for field, binding in clean.items() if (error := comfy.validate_binding(wf.get('nodes') or {}, field, binding))]
    if errors:
        raise HTTPException(status_code=400, detail='绑定无效：' + '；'.join(errors))
    wf["bindings"] = clean
    config.save_settings(s)
    return {"bindings": clean}


@router.get("/comfy/status")
async def comfy_status():
    s = config.load_settings()
    base = comfy.comfy_base(s)
    reachable = False
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            reachable = (await client.get(f"{base}/system_stats")).status_code < 400
    except Exception:
        reachable = False
    wf = active_workflow(s)
    nodes = wf.get("nodes") or {}
    bindings = wf.get("bindings") or {}
    # The node catalog ships with the status so reopening the dialog restores
    # the binding dropdowns (they render blank without it).
    return {"url": base, "reachable": reachable, "has_workflow": bool(nodes),
            "bindings": bindings, "fields": comfy.FIELD_LABELS,
            "workflows": workflow_summaries(s), "active_id": s.get("comfy_active") or "",
            "active_name": wf.get("name") or "",
            "defaults": comfy.parameter_state(wf)[0],
            "params": comfy.parameter_state(wf)[1],
            "overrides": wf.get('params') or {},
            "graph": comfy.build_graph(nodes, wf.get('layout') or {}) if nodes else {"nodes": [], "edges": []},
            "nodes": comfy.node_choices(nodes) if nodes else [],
            "binding_errors": [error for field, binding in bindings.items()
                               if (error := comfy.validate_binding(nodes, field, binding))]}


@router.get("/comfy/choices")
async def comfy_choices():
    """Sampler/scheduler values ComfyUI actually accepts (empty when offline)."""
    return await comfy.fetch_choices(comfy.comfy_base(config.load_settings()))


@router.get("/comfy/graph")
def comfy_graph():
    s = config.load_settings()
    nodes = (active_workflow(s).get("nodes") or {})
    if not nodes:
        return {"nodes": [], "edges": []}
    return comfy.build_graph(nodes, active_workflow(s).get("layout") or {})


@router.put("/comfy/layout")
@workflow_write
def comfy_layout(body: dict):
    """Persist dragged node positions so the graph keeps the user's arrangement."""
    positions = body.get("positions") or {}
    clean = {}
    for node_id, pos in positions.items():
        if isinstance(pos, dict) and isinstance(pos.get("x"), (int, float)) and isinstance(pos.get("y"), (int, float)):
            clean[str(node_id)] = {"x": float(pos["x"]), "y": float(pos["y"])}
    s = config.load_settings()
    wf = _workflow_for(s, body.get('workflow_id'))
    wf["layout"] = clean
    config.save_settings(s)
    return {"positions": clean}


@router.put("/comfy/url")
def comfy_set_url(body: dict):
    url = str(body.get("url") or "").strip()
    if url and not re.match(r"^https?://", url):
        raise HTTPException(status_code=400, detail="地址必须以 http:// 或 https:// 开头")
    s = config.load_settings()
    s["comfy_url"] = url or comfy.COMFY_DEFAULT
    config.save_settings(s)
    return {"url": s["comfy_url"]}


@router.put("/comfy/params")
@workflow_write
def comfy_params(body: dict):
    """Save explicit overrides to the named workflow; reset exposes node defaults."""
    s = config.load_settings()
    wf = _workflow_for(s, body.get('workflow_id'))
    defaults, _ = comfy.parameter_state(wf)
    keep = {k: body[k] for k in defaults if k in body and body[k] != defaults[k]}
    import math
    limits = {'seed':(-1,2**64-1),'width':(64,8192),'height':(64,8192),'steps':(1,200),'cfg':(0,100)}
    for key, value in keep.items():
        if key in limits:
            low, high = limits[key]
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not low <= value <= high or key != 'cfg' and int(value) != value:
                raise ValueError(f'{key} 必须在 {low} 到 {high} 之间' + ('且为整数' if key != 'cfg' else ''))
        elif not isinstance(value,str) or not value.strip(): raise ValueError(f'{key} 不能为空')
    if body.get('reset'): keep = {}
    wf['params'] = keep
    config.save_settings(s)
    return {"params": comfy.parameter_state(wf)[1], "overrides": keep}


@router.post("/comfy/generate")
async def comfy_generate(body: ComfyGenerateBody):
    s = config.load_settings()
    wf = active_workflow(s)
    nodes = wf.get("nodes") or {}
    if not nodes:
        raise HTTPException(status_code=400, detail="还没有导入 ComfyUI workflow")
    bindings = wf.get("bindings") or {}
    errors = [error for field, binding in bindings.items()
              if (error := comfy.validate_binding(nodes, field, binding))]
    if errors:
        raise HTTPException(status_code=400, detail="绑定已失效：" + "；".join(errors))
    values = {key: value for key, value in body.model_dump().items() if value is not None}
    workflow = comfy.apply_bindings(nodes, bindings, values)
    try:
        prompt_id = await comfy.submit(comfy.comfy_base(s), workflow)
        images = await comfy.wait_for_images(comfy.comfy_base(s), prompt_id)
        if not images:
            raise comfy.ComfyError("ComfyUI 没有产出图片（检查 workflow 的输出节点）")
        raw, filename = await comfy.fetch_image(comfy.comfy_base(s), images[0])
    except comfy.ComfyError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"prompt_id": prompt_id, "filename": filename,
            "image": "data:image/png;base64," + base64.b64encode(raw).decode("ascii"),
            "count": len(images)}


