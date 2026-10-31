"""HTTP 接口：工作区（系列/分页/版本）、Agent 会话、档案库、编译、设置、反推。"""

from __future__ import annotations
from .config import workflow_write

import base64
import copy
import json
import mimetypes
from pathlib import Path
import re
import time
import uuid
from typing import Any, Optional

import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import comfy, db, llm
from .agent import run_agent
from . import bridge
from ..inference import _provider_headers
from .config import (APP_VERSION, ATTACH_DIR, CAPTION_PROMPT_PATH, SKILL_COMPILE, SETTINGS_DEFAULTS,
                     active_workflow, load_settings, public_settings, save_settings, workflow_summaries)
from .layout_core import _ensure_wh, _sanitize_layout_draft, compile_safe
from .ops import describe_changes
from .reverse_boxes import box_format_for, items_to_draft, normalize_reverse, reverse_rules
from .skills import resolve_skill

router = APIRouter(prefix="/api/v1/moss")


def _404(what: str = "记录") -> HTTPException:
    return HTTPException(status_code=404, detail=f"{what}不存在")


# ---------- 基础 ----------
@router.get("/health")
def health():
    return {"ok": True, "version": APP_VERSION, "compile": SKILL_COMPILE.exists()}


@router.get("/workspace")
def get_workspace():
    ws = db.workspace()
    ws["state"] = db.kv_get("ui_state", {})
    return ws


class StateBody(BaseModel):
    state: dict


@router.put("/state")
def put_state(body: StateBody):
    cur = db.kv_get("ui_state", {}) or {}
    cur.update(body.state)
    db.kv_set("ui_state", cur)
    return cur


# ---------- 系列 ----------
class NameBody(BaseModel):
    name: Optional[str] = None
    sort: Optional[float] = None


@router.post("/series")
def create_series(body: NameBody):
    s = db.create_series(body.name or "新系列")
    p = db.create_page(s["id"], "第 1 页")
    s["pages"] = [p]
    return s


@router.patch("/series/{sid}")
def patch_series(sid: str, body: NameBody):
    db.update_series(sid, name=body.name, sort=body.sort)
    return {"ok": True}


@router.delete("/series/{sid}")
def remove_series(sid: str):
    db.delete_series(sid)
    if not db.workspace()["series"]:
        s = db.create_series("默认系列")
        db.create_page(s["id"], "第 1 页")
    return {"ok": True}


# ---------- 分页 ----------
class PageCreateBody(BaseModel):
    series_id: str
    name: Optional[str] = None
    doc: Optional[dict] = None
    kind: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None


class RevisionMark(BaseModel):
    source: str = "manual"
    summary: str = ""


class PageUpdateBody(BaseModel):
    doc: Optional[dict] = None
    name: Optional[str] = None
    series_id: Optional[str] = None
    sort: Optional[float] = None
    revision: Optional[RevisionMark] = None


@router.post("/pages")
def create_page(body: PageCreateBody):
    doc = body.doc
    if doc is None:
        w, h = _ensure_wh(body.width or 1024, body.height or 1536)
        doc = db.empty_doc(body.kind or "layout", w, h)
    n = len(db.series_pages(body.series_id)) + 1
    return db.create_page(body.series_id, body.name or f"第 {n} 页", doc)


@router.get("/pages/{pid}")
def get_page(pid: str):
    p = db.get_page(pid)
    if not p:
        raise _404("页面")
    return p


@router.put("/pages/{pid}")
def put_page(pid: str, body: PageUpdateBody):
    old = db.get_page(pid)
    if not old:
        raise _404("页面")
    if body.revision and body.doc is not None:
        summary = body.revision.summary or "；".join(describe_changes(old["doc"], db.normalize_doc(body.doc))[:4])
        db.add_revision(pid, old["doc"], body.revision.source, summary)
    return db.update_page(pid, doc=body.doc, name=body.name, series_id=body.series_id, sort=body.sort)


@router.post("/pages/{pid}/duplicate")
def duplicate_page(pid: str):
    p = db.get_page(pid)
    if not p:
        raise _404("页面")
    return db.create_page(p["series_id"], p["name"] + " 副本", copy.deepcopy(p["doc"]))


@router.delete("/pages/{pid}")
def remove_page(pid: str):
    p = db.get_page(pid)
    if not p:
        raise _404("页面")
    db.delete_page(pid)
    if not db.series_pages(p["series_id"]):
        db.create_page(p["series_id"], "第 1 页")
    return {"ok": True}


# ---------- 版本记录 ----------
@router.get("/pages/{pid}/revisions")
def page_revisions(pid: str):
    return db.list_revisions(pid)


@router.get("/revisions/{rid}")
def get_revision(rid: str):
    r = db.get_revision(rid)
    if not r:
        raise _404("版本")
    return r


@router.post("/revisions/{rid}/restore")
def restore_revision(rid: str):
    r = db.get_revision(rid)
    if not r:
        raise _404("版本")
    cur = db.get_page(r["page_id"])
    if not cur:
        raise _404("页面")
    db.add_revision(r["page_id"], cur["doc"], "restore", "回滚前的状态")
    return db.update_page(r["page_id"], doc=r["doc"])


# ---------- 会话 ----------
class SessionCreateBody(BaseModel):
    series_id: str
    title: Optional[str] = None


class SessionPatchBody(BaseModel):
    title: Optional[str] = None
    closed: Optional[bool] = None


def _session_public(s: dict) -> dict:
    meta = s.get("meta") or {}
    return {k: v for k, v in s.items() if k != "meta"} | {
        "summary": meta.get("summary") or "", "protocol": meta.get("protocol") or ""}


@router.get("/series/{sid}/sessions")
def series_sessions(sid: str):
    return [_session_public(s) for s in db.list_sessions(sid)]


@router.post("/sessions")
def create_session(body: SessionCreateBody):
    return _session_public(db.create_session(body.series_id, body.title or "新对话"))


@router.patch("/sessions/{sid}")
def patch_session(sid: str, body: SessionPatchBody):
    s = db.update_session(sid, title=body.title, closed=body.closed)
    if not s:
        raise _404("会话")
    return _session_public(s)


@router.delete("/sessions/{sid}")
def remove_session(sid: str):
    db.delete_session(sid)
    return {"ok": True}


@router.post("/sessions/{sid}/clear")
def clear_session(sid: str):
    """清空对话：删掉全部消息和摘要 / 已读快照，标题回到“新对话”。页面内容不受影响。"""
    s = db.get_session(sid)
    if not s:
        raise _404("会话")
    db.delete_messages_from(sid, 0)
    meta = s.get("meta") or {}
    keep = {k: v for k, v in meta.items() if k == "protocol"}
    return _session_public(db.update_session(sid, title="新对话", meta=keep) or s)


@router.get("/sessions/{sid}/messages")
def session_messages(sid: str):
    if not db.get_session(sid):
        raise _404("会话")
    messages = db.list_messages(sid)
    # Preserve history on disk; do not present a model-written audit line as a
    # verified change when the original turn has no tool/proposal evidence.
    import re
    for message in messages:
        meta = message.get('meta') or {}
        if message['role']=='assistant' and not meta.get('steps') and not meta.get('proposals') and re.search(r'(?m)^\s*\[(?:执行的操作|改动「)[^\n]*(?:→成功|用户已采纳)',message.get('content') or ''):
            message['meta']={**meta,'error':meta.get('error') or '此回复没有实际修改记录，画面未更新。可重新生成。'}
    return messages


class RunBody(BaseModel):
    page_id: str
    doc: dict
    view: Optional[dict] = None
    message: str
    selection: list[str] = Field(default_factory=list)
    skill_ids: list[str] = Field(default_factory=list)
    attachments: list[str] = Field(default_factory=list)
    replace_from_seq: Optional[int] = None
    quick: Optional[str] = None
    mode: Optional[str] = None
    request_id: Optional[str] = None


@router.get('/sessions/{sid}/run')
def active_session_run(sid: str):
    from ..atelier.jobs import running_for_session
    if not db.get_session(sid): raise _404('会话')
    record = running_for_session(sid)
    return {'job_id': record['id'] if record else None}


class CancelRunBody(BaseModel):
    request_id: str = Field(min_length=1,max_length=64)


@router.post('/sessions/{sid}/cancel')
async def cancel_session_request(sid: str, body: CancelRunBody):
    from ..atelier import store
    from ..atelier.jobs import active
    if not db.get_session(sid): raise _404('会话')
    with store.connection() as connection:
        row=connection.execute("SELECT id FROM atelier_jobs WHERE kind='agent' AND json_extract(data,'$.session_id')=? AND json_extract(data,'$.request_id')=? ORDER BY updated_at DESC LIMIT 1",(sid,body.request_id)).fetchone()
    if row:
        record=store.job(row['id'])
        if record['status'] not in ('queued','running'): return record
        if record['id'] in active: active[record['id']].cancel()
        return store.update_job(record['id'],status='cancelled')
    # A stop can arrive before the original POST has been handled. Persist its
    # identity so a late/deduplicated run cannot start model or tool execution.
    record=store.create_job('agent','创作 Agent',{'session_id':sid,'request_id':body.request_id})
    return store.update_job(record['id'],status='cancelled')


@router.post("/sessions/{sid}/run")
async def run_session(sid: str, body: RunBody):
    if not body.message.strip() and not body.attachments:
        raise HTTPException(status_code=400, detail="消息为空")
    from ..atelier.jobs import start_agent, stream_agent, running_for_session
    from ..atelier import providers, store
    if not db.get_session(sid): raise _404('会话')
    existing = running_for_session(sid)
    if existing:
        if not body.request_id or existing['data'].get('request_id') != body.request_id:
            raise HTTPException(status_code=409, detail='此对话已有 Agent 任务在运行，请先恢复连接或停止该任务')
        return StreamingResponse(stream_agent(existing['id']),media_type='text/event-stream',headers={'Cache-Control':'no-cache','X-Atelier-Job':existing['id']})
    if body.request_id:
        with store.connection() as connection:
            previous = connection.execute("SELECT id FROM atelier_jobs WHERE kind='agent' AND json_extract(data,'$.session_id')=? AND json_extract(data,'$.request_id')=? ORDER BY updated_at DESC LIMIT 1",(sid,body.request_id)).fetchone()
        if previous:
            return StreamingResponse(stream_agent(previous['id']),media_type='text/event-stream',headers={'Cache-Control':'no-cache','X-Atelier-Job':previous['id']})
    gen = run_agent(session_id=sid, page_id=body.page_id, doc=db.normalize_doc(body.doc), view=body.view,
                    message=body.message.strip(), selection=body.selection, skill_ids=body.skill_ids,
                    attachments=body.attachments, replace_from_seq=body.replace_from_seq, quick=body.quick,
                    mode=body.mode if body.mode in ("draft",) else None)
    with providers.frozen_request():
        identifier=start_agent(gen,'创作 Agent',{'session_id':sid,'page_id':body.page_id,'request_id':body.request_id,'provider_id':providers.request_settings().get('provider_id'),'model':providers.request_settings().get('model')})
    return StreamingResponse(stream_agent(identifier),media_type='text/event-stream',headers={'Cache-Control':'no-cache','X-Atelier-Job':identifier})


class ProposalBody(BaseModel):
    page_id: str
    status: str  # accepted | rejected | partial
    applied_doc: Optional[dict] = None
    expected_doc: Optional[dict] = None


@router.post("/messages/{mid}/proposal")
def resolve_proposal(mid: str, body: ProposalBody):
    m = db.get_message(mid)
    if not m:
        raise _404("消息")
    if body.status not in ("accepted", "rejected", "partial"):
        raise HTTPException(status_code=400, detail="status 无效")
    meta = dict(m.get("meta") or {})
    props = meta.get("proposals") or []
    hit = None
    for p in props:
        if p.get("page_id") == body.page_id:
            hit = p
    if hit is None:
        raise _404("改动")
    page = db.get_page(body.page_id)
    if body.status != "rejected" and page is not None and body.expected_doc is not None and db.normalize_doc(body.expected_doc) != page["doc"]:
        raise HTTPException(status_code=409, detail="成稿已更新，请重新检查改动后采纳")
    hit["status"] = body.status
    new_doc = None
    if body.status != "rejected" and page is not None:
        new_doc = db.normalize_doc(body.applied_doc if body.applied_doc is not None else hit["proposed"])
        locked={segment['id']:segment for segment in page['doc'].get('caption',{}).get('segments',[]) if segment.get('locked')}
        proposed={segment['id']:segment for segment in new_doc.get('caption',{}).get('segments',[])}
        if any(identifier not in proposed or proposed[identifier].get('text')!=segment.get('text') for identifier,segment in locked.items()):
            raise HTTPException(status_code=409,detail='固定段落被改动，请先解除固定或重新生成提案')
        summ = hit.get("summary") or []
        summ = "；".join(summ[:4]) if isinstance(summ, list) else str(summ)
        db.add_revision(body.page_id, page["doc"], "agent", ("采纳部分：" if body.status == "partial" else "") + (summ or "Agent 改动"))
        db.update_page(body.page_id, doc=new_doc)
    if body.applied_doc is not None:
        hit["applied"] = db.normalize_doc(body.applied_doc)
    meta["proposals"] = props
    db.update_message(mid, meta=meta)
    # Agent 下一轮以“用户真正保留的版本”为基准
    sess = db.get_session(m["session_id"])
    if sess:
        smeta = dict(sess.get("meta") or {})
        seen = dict(smeta.get("seen") or {})
        if page is not None:
            seen[body.page_id] = new_doc if new_doc is not None else page["doc"]
        smeta["seen"] = seen
        db.update_session(m["session_id"], meta=smeta)
    return {"message": db.get_message(mid), "page": db.get_page(body.page_id)}


# ---------- 附件 ----------
_ALLOWED_IMG = {"image/png", "image/jpeg", "image/webp", "image/gif"}


@router.post("/attachments")
async def upload_attachment(file: UploadFile = File(...)):
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="空文件")
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="图片过大（上限 15MB）")
    mime = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "image/png"
    if mime not in _ALLOWED_IMG:
        raise HTTPException(status_code=400, detail="只支持 PNG / JPEG / WebP / GIF 图片")
    ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}[mime]
    aid = uuid.uuid4().hex[:16]
    ATTACH_DIR.mkdir(parents=True, exist_ok=True)
    (ATTACH_DIR / f"{aid}{ext}").write_bytes(raw)
    w = h = None
    try:  # 读 PNG/JPEG 尺寸，便于“按参考图横竖”提示
        w, h = _image_size(raw)
    except Exception:  # noqa: BLE001
        pass
    return {"id": f"{aid}{ext}", "name": file.filename or f"{aid}{ext}", "mime": mime, "width": w, "height": h}


def _image_size(raw: bytes) -> tuple[Optional[int], Optional[int]]:
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    if raw[:2] == b"\xff\xd8":
        i = 2
        while i < len(raw) - 9:
            if raw[i] != 0xFF:
                i += 1
                continue
            marker = raw[i + 1]
            seg = int.from_bytes(raw[i + 2:i + 4], "big")
            if marker in (0xC0, 0xC1, 0xC2):
                return int.from_bytes(raw[i + 7:i + 9], "big"), int.from_bytes(raw[i + 5:i + 7], "big")
            i += 2 + seg
    return None, None


@router.get("/attachments/{aid}")
def get_attachment(aid: str):
    if not re.fullmatch(r"[0-9a-f]{16}\.(png|jpg|webp|gif)", aid):
        raise _404("附件")
    p = ATTACH_DIR / aid
    if not p.exists():
        raise _404("附件")
    return FileResponse(p)


# ---------- 档案库 ----------
class ArchiveBody(BaseModel):
    title: str = "未命名"
    category: str = ""
    doc: dict
    prompt: str = ""


class ArchivePatch(BaseModel):
    title: Optional[str] = None
    category: Optional[str] = None


@router.get("/archive")
def list_archive():
    return db.list_archive()


@router.post("/archive")
def add_archive(body: ArchiveBody):
    return db.add_archive(body.title, body.category, body.doc, body.prompt)


@router.patch("/archive/{aid}")
def patch_archive(aid: str, body: ArchivePatch):
    db.update_archive(aid, body.title, body.category)
    return db.get_archive(aid)


@router.delete("/archive/{aid}")
def remove_archive(aid: str):
    db.delete_archive(aid)
    return {"ok": True}


# ---------- 编译 ----------
class CompileBody(BaseModel):
    draft: dict
    view: Optional[dict] = None


@router.post("/compile")
async def api_compile(body: CompileBody):
    from ..atelier.creation import compile_document
    kind='layout' if 'items' in body.draft else 'caption'
    return await compile_document({'kind':kind,kind:body.draft},'moss',view=body.view)


# ---------- 设置 ----------
class SettingsBody(BaseModel):
    provider_id: Optional[str] = None
    model: Optional[str] = None
    vision_model: Optional[str] = None
    fallback_models: Optional[str] = None
    temperature: Optional[float] = None
    agent_protocol: Optional[str] = None
    context_turns: Optional[int] = None
    prompt_prefix: Optional[str] = None
    negative_prompt: Optional[str] = None


class ProbeBody(BaseModel):
    provider_id: Optional[str] = None
    model: Optional[str] = None


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
    from ..atelier import store
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
        s = load_settings()
        name = (body.name or '').strip() or f"工作流 {len(s.get('comfy_workflows') or {}) + 1}"
        wid = uuid.uuid4().hex[:10]
        phase('saving')
        s.setdefault('comfy_workflows',{})[wid] = {'name':name,'nodes':nodes,'bindings':suggested,'layout':{},'params':{},'created_at':time.strftime('%Y-%m-%dT%H:%M:%S%z')}
        s['comfy_active'] = wid
        save_settings(s)
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
    s = load_settings()
    return {"workflows": workflow_summaries(s), "active_id": s.get("comfy_active") or ""}


@router.put("/comfy/workflows/active")
@workflow_write
def comfy_activate(body: dict):
    """Switch the active workflow. Bindings/layout travel with each workflow."""
    wid = str(body.get("id") or "")
    s = load_settings()
    workflows = s.get("comfy_workflows") or {}
    if wid not in workflows:
        raise HTTPException(status_code=404, detail="工作流不存在")
    s["comfy_active"] = wid
    save_settings(s)
    return {"active_id": wid, "workflows": workflow_summaries(s)}


@router.put("/comfy/workflows/{wid}")
@workflow_write
def comfy_rename(wid: str, body: dict):
    s = load_settings()
    wf = (s.get("comfy_workflows") or {}).get(wid)
    if not isinstance(wf, dict):
        raise HTTPException(status_code=404, detail="工作流不存在")
    name = str(body.get("name") or "").strip()
    if name:
        wf["name"] = name
    save_settings(s)
    return {"workflows": workflow_summaries(s)}


@router.delete("/comfy/workflows/{wid}")
@workflow_write
def comfy_delete_workflow(wid: str):
    s = load_settings()
    workflows = s.get("comfy_workflows") or {}
    if wid not in workflows:
        raise HTTPException(status_code=404, detail="工作流不存在")
    workflows.pop(wid)
    if s.get("comfy_active") == wid:
        s["comfy_active"] = next(iter(workflows), "")
    save_settings(s)
    return {"workflows": workflow_summaries(s), "active_id": s.get("comfy_active") or ""}


@router.put("/comfy/bindings")
@workflow_write
def comfy_bindings(body: ComfyBindBody):
    s = load_settings()
    clean = {}
    for field, binding in (body.bindings or {}).items():
        if field in comfy.FIELDS and isinstance(binding, dict) and binding.get("node"):
            clean[field] = {"node": str(binding["node"]), "input": str(binding.get("input") or "")}
    wf = _workflow_for(s, body.workflow_id)
    errors = [error for field, binding in clean.items() if (error := comfy.validate_binding(wf.get('nodes') or {}, field, binding))]
    if errors:
        raise HTTPException(status_code=400, detail='绑定无效：' + '；'.join(errors))
    wf["bindings"] = clean
    save_settings(s)
    return {"bindings": clean}


@router.get("/comfy/status")
async def comfy_status():
    s = load_settings()
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
    return await comfy.fetch_choices(comfy.comfy_base(load_settings()))


@router.get("/comfy/graph")
def comfy_graph():
    s = load_settings()
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
    s = load_settings()
    wf = _workflow_for(s, body.get('workflow_id'))
    wf["layout"] = clean
    save_settings(s)
    return {"positions": clean}


@router.put("/comfy/url")
def comfy_set_url(body: dict):
    url = str(body.get("url") or "").strip()
    if url and not re.match(r"^https?://", url):
        raise HTTPException(status_code=400, detail="地址必须以 http:// 或 https:// 开头")
    s = load_settings()
    s["comfy_url"] = url or comfy.COMFY_DEFAULT
    save_settings(s)
    return {"url": s["comfy_url"]}


@router.put("/comfy/params")
@workflow_write
def comfy_params(body: dict):
    """Save explicit overrides to the named workflow; reset exposes node defaults."""
    s = load_settings()
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
    save_settings(s)
    return {"params": comfy.parameter_state(wf)[1], "overrides": keep}


@router.post("/comfy/generate")
async def comfy_generate(body: ComfyGenerateBody):
    s = load_settings()
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


@router.get("/settings")
def get_settings():
    return public_settings(load_settings())


@router.put("/settings")
def put_settings(body: SettingsBody):
    s = load_settings()
    data = body.model_dump(exclude_none=True)
    s.update({k: v for k, v in data.items() if k in SETTINGS_DEFAULTS})
    return public_settings(save_settings(s))


def _resolve_creds(body: Optional[ProbeBody] = None) -> tuple[str, str]:
    s = load_settings()
    provider_id = (body.provider_id if body is not None and body.provider_id else None) or s.get("provider_id")
    try:
        resolved = bridge.resolve(provider_id)
    except bridge.ProviderError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    from ..provider_manager import requires_api_key
    if not resolved["api_key"] and getattr(resolved["provider"], "kind", "") != "local" and requires_api_key(resolved["provider"]):
        raise HTTPException(status_code=400, detail=f"提供商 {resolved['provider'].name} 未配置密钥：请在系统设置中设置对应的环境变量。")
    return resolved["base_url"], resolved["api_key"]


def _auth_headers(key: str) -> dict[str, str]:
    # The local engine needs no key; an empty "Bearer " header makes
    # llama-server reject the request, so omit it entirely when unset.
    return {"Authorization": f"Bearer {key}"} if key else {}


async def _list_models(client: httpx.AsyncClient, base: str, key: str, headers: dict | None = None) -> list[str]:
    r = await client.get(f"{base}/models", headers=headers if headers is not None else _auth_headers(key))
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"GET /models 失败 {r.status_code}: {r.text[:300]}")
    try:
        data = r.json()
        return sorted({m.get("id") for m in (data.get("data") or []) if isinstance(m, dict) and m.get("id")})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"解析模型列表失败: {e}") from e


@router.post("/settings/test")
async def test_settings(body: ProbeBody = ProbeBody()):
    """Use the actual Agent adapters; an empty HTTP 200 is never a passing probe."""
    from ..atelier import providers
    base, key = _resolve_creds(body)
    settings = load_settings()
    selected = bridge.resolve(body.provider_id or settings.get('provider_id'))
    model = body.model or settings.get('model') or selected['provider'].default_model
    started = time.perf_counter()
    out = dict(ok=False,base_url=base,models_ok=False,chat_ok=False,stream_ok=False,tools_ok=False,model_count=0,sample_models=[])
    tool = {'type':'function','function':{'name':'ping','description':'Connection test','parameters':{'type':'object','properties':{'n':{'type':'integer'}},'required':['n']}}}
    async def probe(tools):
        async for kind,value in providers.stream([{'role':'user','content':'Call ping with n=1.' if tools else 'Reply ping.'}],model=model,provider_id=selected['provider'].id,max_tokens=128,temperature=0,tools=tools):
            if kind in ('text','reasoning') and value: out['stream_ok']=True
            if kind=='done':
                out['chat_ok']=bool(value.get('content') or value.get('tool_calls'))
                out['tools_ok']=bool(value.get('tool_calls'))
                out['stream_ok']=out['stream_ok'] or out['tools_ok']
    try:
        try: await probe([tool])
        except providers.ToolsUnsupported:
            out['tools_note']='此服务拒绝函数调用，Agent 自动模式将使用标签协议'
            await probe(None)
        out['ok']=out['chat_ok'] and out['stream_ok']
        out['message']='连接正常' if out['ok'] else '服务未返回完整内容'
    except (ValueError,httpx.HTTPError) as exc: out['message']=str(exc)
    out.update(tested_model=model,latency_ms=int((time.perf_counter()-started)*1000))
    return out


@router.post("/settings/models")
async def list_upstream_models(body: ProbeBody = ProbeBody()):
    base, key = _resolve_creds(body)
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            ids = await _list_models(client, base, key, _provider_headers(bridge.resolve(body.provider_id or load_settings().get('provider_id'))['provider']) if (body.provider_id or load_settings().get('provider_id')) != 'local' else {})
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"无法连接上游: {e}") from e
    return {"base_url": base, "models": ids, "count": len(ids)}


# ---------- 图像反推 ----------
def _load_caption_prompt() -> str:
    if CAPTION_PROMPT_PATH.exists():
        text = CAPTION_PROMPT_PATH.read_text(encoding="utf-8")
        m = re.search(r"```text\n([\s\S]*?)```", text)
        if m:
            return m.group(1).replace("{{reference}}", "(none)")
    return ('You are an image recaptioner. Return exactly one JSON object with schema '
            '{"caption":{"long":"...","medium":"...","short":"..."},"watermark":[],"borders":["none"]}')


LAYOUT_REVERSE_DETAIL = {
    "long": ("Detail level: LONG. Write rich, vivid English captions for summary.caption and every item.caption — "
             "appearance, materials, lighting, pose, spatial relations. Keep visible text exact in the text field "
             "when label is text."),
    "medium": ("Detail level: MEDIUM. Balanced English captions — clear subject, scene, and key traits without "
               "excessive flourish. Keep visible text exact in the text field when label is text."),
    "short": ("Detail level: SHORT. Concise English captions — only essentials for summary and each item. "
              "Keep visible text exact in the text field when label is text."),
}


async def _vision(messages: list[dict], model: str, temperature: float, provider_id: str | None = None) -> str:
    try:
        if provider_id:
            from ..atelier.providers import complete
            return (await complete(messages,model=model,temperature=temperature,provider_id=provider_id)).get('content','')
        return await llm.chat(messages, model=model, max_tokens=8192, temperature=temperature)
    except llm.UpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.post("/reverse")
async def api_reverse(
    file: UploadFile = File(...),
    mode: str = Form("caption"),
    detail: str = Form("medium"),
    width: Optional[int] = Form(None),
    height: Optional[int] = Form(None),
    skill_id: Optional[str] = Form(None),
    image_width: Optional[int] = Form(None),
    image_height: Optional[int] = Form(None),
    provider_id: Optional[str] = Form(None),
):
    s = load_settings()
    try:
        bridge.resolve(provider_id or s.get("provider_id"))
    except bridge.ProviderError as exc:
        raise HTTPException(status_code=400, detail=f"无法调用视觉模型做图像反推：{exc}") from exc
    mode = (mode or "caption").strip().lower()
    if mode not in ("caption", "layout"):
        raise HTTPException(status_code=400, detail="mode 必须是 caption 或 layout")
    detail = (detail or "medium").strip().lower()
    if detail not in LAYOUT_REVERSE_DETAIL:
        raise HTTPException(status_code=400, detail="detail 必须是 long|medium|short")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="空文件")
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="图片过大（上限 15MB）")
    mime = file.content_type or "image/jpeg"
    data_url = f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"
    vision_model = s.get("vision_model") or s.get("model") or "gpt-4o"
    if provider_id=='local':
        from .. import config_manager as cfg
        from ..process_manager import process_manager
        if process_manager.get_status().state!='running' or not cfg.get_config().mmproj_path:
            raise HTTPException(status_code=409,detail='请先启动带有 MMProj 的视觉 GGUF 档案')
        vision_model=Path(cfg.get_config().model_path).name

    if mode == "caption":
        messages = [{"role": "user", "content": [
            {"type": "text", "text": _load_caption_prompt()},
            {"type": "image_url", "image_url": {"url": data_url}}]}]
        content = await _vision(messages, vision_model, 0.7, provider_id)
        try:
            result = llm.extract_json(content)
        except (json.JSONDecodeError, ValueError) as e:
            raise HTTPException(status_code=502, detail=f"反推结果无法解析: {e}\n{content[:800]}") from e
        if not isinstance(result.get("caption"), dict):
            if all(k in result for k in ("long", "medium", "short")):
                result = {"caption": {k: str(result.get(k) or "") for k in ("long", "medium", "short")},
                          "watermark": result.get("watermark") or [], "borders": result.get("borders") or ["none"]}
            else:
                raise HTTPException(status_code=502, detail=f"反推缺少 caption 字段: {str(result)[:400]}")
        result["mode"] = "caption"
        result["detail"] = detail
        return result

    img_w, img_h = _image_size(raw)
    img_w = img_w or image_width
    img_h = img_h or image_height
    if width is None or height is None:
        width, height = width or img_w or 1024, height or img_h or 1024
    w, h = _ensure_wh(int(width), int(height))
    skill = resolve_skill("layout", skill_id)
    fmt = box_format_for(vision_model)
    system = (skill["system_prompt"] + "\n\n" + reverse_rules(fmt, img_w, img_h, LAYOUT_REVERSE_DETAIL[detail]))
    messages = [{"role": "system", "content": system}, {"role": "user", "content": [
        {"type": "text", "text": f"请看这张参考图，按要求输出 JSON：整体描述 + 每个可见元素的定位框（{fmt}，0–1000 归一化）。"
                                 f"detail={detail}。"},
        {"type": "image_url", "image_url": {"url": data_url}}]}]
    content = await _vision(messages, vision_model, 0.3)
    try:
        parsed = llm.extract_json(content)
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=502, detail=f"Layout 反推无法解析: {e}\n{content[:800]}") from e
    norm = normalize_reverse(parsed, img_w, img_h)
    if not norm["items"]:
        # 模型没按要求给坐标：退回旧格式（画布像素 bbox）
        legacy = _sanitize_layout_draft(parsed if isinstance(parsed, dict) else {}, w, h)
        norm["items"] = [{**{k: v for k, v in it.items() if k != "bbox"},
                          "box": [it["bbox"][0] / w, it["bbox"][1] / h, it["bbox"][2] / w, it["bbox"][3] / h]}
                         for it in legacy["items"]]
    draft = _sanitize_layout_draft(items_to_draft(norm, w, h), w, h)
    prompt, cerr = compile_safe(draft)
    out: dict[str, Any] = {
        "mode": "layout", "detail": detail, "box_format": fmt,
        "image": {"width": img_w, "height": img_h},
        "summary": norm["summary"], "items": norm["items"], "dropped": norm["dropped"],
        "draft": draft, "prompt": prompt, "raw": content[:4000],
    }
    if cerr:
        out["compile_error"] = cerr
    return out
