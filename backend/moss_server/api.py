"""HTTP 接口：工作区（系列/分页/版本）、Agent 会话、档案库、编译、设置、反推。"""

from __future__ import annotations

import base64
import copy
import json
import mimetypes
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
from .config import (APP_VERSION, ATTACH_DIR, CAPTION_PROMPT_PATH, SKILL_COMPILE, SETTINGS_DEFAULTS,
                     load_settings, public_settings, save_settings)
from .layout_core import _ensure_wh, _sanitize_layout_draft, compile_checks, compile_safe, sanitize_draft
from .ops import describe_changes
from .reverse_boxes import box_format_for, items_to_draft, normalize_reverse, reverse_rules
from .skills import resolve_skill

router = APIRouter(prefix="/api/moss")


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
    return db.list_messages(sid)


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


@router.post("/sessions/{sid}/run")
async def run_session(sid: str, body: RunBody):
    if not body.message.strip() and not body.attachments:
        raise HTTPException(status_code=400, detail="消息为空")
    gen = run_agent(session_id=sid, page_id=body.page_id, doc=db.normalize_doc(body.doc), view=body.view,
                    message=body.message.strip(), selection=body.selection, skill_ids=body.skill_ids,
                    attachments=body.attachments, replace_from_seq=body.replace_from_seq, quick=body.quick,
                    mode=body.mode if body.mode in ("draft",) else None)
    return StreamingResponse(gen, media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class ProposalBody(BaseModel):
    page_id: str
    status: str  # accepted | rejected | partial
    applied_doc: Optional[dict] = None


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
    hit["status"] = body.status
    new_doc = None
    if body.status != "rejected" and page is not None:
        new_doc = db.normalize_doc(body.applied_doc if body.applied_doc is not None else hit["proposed"])
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
def api_compile(body: CompileBody):
    draft = sanitize_draft(body.draft)
    prompt, err = compile_safe(draft, body.view)
    checks = compile_checks(draft) if "items" in draft else []
    if err:
        raise HTTPException(status_code=400, detail=err)
    s = load_settings()
    return {"prompt": prompt, "checks": checks, "prefix": s.get("prompt_prefix") or "",
            "negative": s.get("negative_prompt") or ""}


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


class ComfyBindBody(BaseModel):
    bindings: dict[str, dict]


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
def comfy_import(body: ComfyImportBody):
    """Parse an API-format workflow and return its bindable nodes."""
    try:
        nodes = comfy.parse_workflow(body.workflow)
    except comfy.ComfyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    s = load_settings()
    s["comfy_workflow"] = nodes
    save_settings(s)
    return {"nodes": comfy.node_choices(nodes), "fields": comfy.FIELD_LABELS, "suggested": comfy.guess_bindings(nodes)}


@router.put("/comfy/bindings")
def comfy_bindings(body: ComfyBindBody):
    s = load_settings()
    clean = {}
    for field, binding in (body.bindings or {}).items():
        if field in comfy.FIELDS and isinstance(binding, dict) and binding.get("node"):
            clean[field] = {"node": str(binding["node"]), "input": str(binding.get("input") or "")}
    s["comfy_bindings"] = clean
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
    nodes = s.get("comfy_workflow") or {}
    bindings = s.get("comfy_bindings") or {}
    # The node catalog ships with the status so reopening the dialog restores
    # the binding dropdowns (they render blank without it).
    return {"url": base, "reachable": reachable, "has_workflow": bool(nodes),
            "bindings": bindings, "fields": comfy.FIELD_LABELS,
            "params": s.get("comfy_params") or {},
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
    nodes = s.get("comfy_workflow") or {}
    if not nodes:
        return {"nodes": [], "edges": []}
    return comfy.build_graph(nodes, s.get("comfy_layout") or {})


@router.put("/comfy/layout")
def comfy_layout(body: dict):
    """Persist dragged node positions so the graph keeps the user's arrangement."""
    positions = body.get("positions") or {}
    clean = {}
    for node_id, pos in positions.items():
        if isinstance(pos, dict) and isinstance(pos.get("x"), (int, float)) and isinstance(pos.get("y"), (int, float)):
            clean[str(node_id)] = {"x": float(pos["x"]), "y": float(pos["y"])}
    s = load_settings()
    s["comfy_layout"] = clean
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
def comfy_params(body: dict):
    """Remember the last used generation parameters (not the workflow)."""
    keep = {k: body[k] for k in ("positive", "negative", "seed", "width", "height", "cfg", "sampler", "scheduler", "steps") if k in body}
    s = load_settings()
    s["comfy_params"] = keep
    save_settings(s)
    return {"params": keep}


@router.post("/comfy/generate")
async def comfy_generate(body: ComfyGenerateBody):
    s = load_settings()
    nodes = s.get("comfy_workflow") or {}
    if not nodes:
        raise HTTPException(status_code=400, detail="还没有导入 ComfyUI workflow")
    bindings = s.get("comfy_bindings") or {}
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
    if not resolved["api_key"] and getattr(resolved["provider"], "kind", "") != "local":
        raise HTTPException(status_code=400, detail=f"提供商 {resolved['provider'].name} 未配置密钥：请在系统设置中设置对应的环境变量。")
    return resolved["base_url"], resolved["api_key"]


def _auth_headers(key: str) -> dict[str, str]:
    # The local engine needs no key; an empty "Bearer " header makes
    # llama-server reject the request, so omit it entirely when unset.
    return {"Authorization": f"Bearer {key}"} if key else {}


async def _list_models(client: httpx.AsyncClient, base: str, key: str) -> list[str]:
    r = await client.get(f"{base}/models", headers=_auth_headers(key))
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"GET /models 失败 {r.status_code}: {r.text[:300]}")
    try:
        data = r.json()
        return sorted({m.get("id") for m in (data.get("data") or []) if isinstance(m, dict) and m.get("id")})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"解析模型列表失败: {e}") from e


@router.post("/settings/test")
async def test_settings(body: ProbeBody = ProbeBody()):
    """依次探测：GET /models → 流式 chat → 流式 function calling。"""
    base, key = _resolve_creds(body)
    s = load_settings()
    out: dict[str, Any] = {"ok": False, "base_url": base, "models_ok": False, "chat_ok": False,
                           "stream_ok": False, "tools_ok": False, "latency_ms": None, "model_count": 0,
                           "sample_models": [], "message": ""}
    t0 = time.perf_counter()
    headers = {**_auth_headers(key), "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(40.0, connect=10.0)) as client:
        try:
            ids = await _list_models(client, base, key)
            out["models_ok"] = True
        except HTTPException as e:
            ids = []
            out["models_note"] = str(e.detail)
        except httpx.RequestError as e:
            out["message"] = f"无法连接上游: {e}"
            return out
        out["model_count"] = len(ids)
        out["sample_models"] = ids[:12]
        use_model = (body.model or "").strip() or s.get("model") or (ids[0] if ids else "gpt-4o-mini")
        out["tested_model"] = use_model
        payload = {
            "model": use_model, "stream": True, "max_tokens": 64, "temperature": 0,
            "messages": [{"role": "user", "content": "调用 ping 工具，参数 n=1。"}],
            "tools": [{"type": "function", "function": {
                "name": "ping", "description": "连通性测试",
                "parameters": {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]}}}],
        }
        try:
            async with client.stream("POST", f"{base}/chat/completions", headers=headers, json=payload) as r:
                if r.status_code >= 400:
                    txt = (await r.aread()).decode("utf-8", "replace")[:300]
                    # 有的接口拒绝 tools：退回普通流式再测一次
                    payload.pop("tools")
                    payload["messages"] = [{"role": "user", "content": "ping"}]
                    out["tools_note"] = f"{r.status_code}: {txt}"
                else:
                    async for line in r.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        out["stream_ok"] = True
                        try:
                            ch = (json.loads(data).get("choices") or [{}])[0]
                        except Exception:  # noqa: BLE001
                            continue
                        if (ch.get("delta") or {}).get("tool_calls") or ch.get("finish_reason") == "tool_calls":
                            out["tools_ok"] = True
                    out["chat_ok"] = True
            if not out["chat_ok"]:
                async with client.stream("POST", f"{base}/chat/completions", headers=headers, json=payload) as r:
                    if r.status_code >= 400:
                        txt = (await r.aread()).decode("utf-8", "replace")[:300]
                        out["message"] = f"chat 失败 {r.status_code}: {txt}"
                        out["latency_ms"] = int((time.perf_counter() - t0) * 1000)
                        return out
                    async for line in r.aiter_lines():
                        if line.startswith("data:") and line[5:].strip() not in ("", "[DONE]"):
                            out["stream_ok"] = True
                    out["chat_ok"] = True
        except httpx.RequestError as e:
            out["message"] = f"chat 连接失败: {e}"
            out["latency_ms"] = int((time.perf_counter() - t0) * 1000)
            return out
    out["latency_ms"] = int((time.perf_counter() - t0) * 1000)
    out["ok"] = out["chat_ok"]
    feats = [("流式", out["stream_ok"]), ("函数调用", out["tools_ok"])]
    out["message"] = (f"连通正常 · {out['latency_ms']} ms · 模型 {use_model} · "
                      + " · ".join(f"{n}{'✓' if ok else '✗'}" for n, ok in feats))
    if not out["tools_ok"]:
        out["message"] += "（Agent 将自动使用标签协议）"
    return out


@router.post("/settings/models")
async def list_upstream_models(body: ProbeBody = ProbeBody()):
    base, key = _resolve_creds(body)
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            ids = await _list_models(client, base, key)
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


async def _vision(messages: list[dict], model: str, temperature: float) -> str:
    try:
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
):
    s = load_settings()
    try:
        bridge.resolve(s.get("provider_id"))
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

    if mode == "caption":
        messages = [{"role": "user", "content": [
            {"type": "text", "text": _load_caption_prompt()},
            {"type": "image_url", "image_url": {"url": data_url}}]}]
        content = await _vision(messages, vision_model, 0.7)
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
