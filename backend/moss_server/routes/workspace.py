from __future__ import annotations

"""Workspace routes: health, series, pages, revisions and editor state."""
import copy
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from .common import _404
from ..ops import describe_changes
from ..layout_core import _ensure_wh
from .. import db
from ..config import APP_VERSION, SKILL_COMPILE

router = APIRouter(prefix="/api/v1/moss")


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
