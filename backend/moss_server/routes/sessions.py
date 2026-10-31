from __future__ import annotations

"""Agent sessions: history, streaming runs, proposals and attachments."""
from typing import Optional

import mimetypes
import re
import uuid
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from .. import agent
from .common import _404
from .. import db
from ..config import ATTACH_DIR

router = APIRouter(prefix="/api/v1/moss")


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
    from ...atelier.jobs import running_for_session
    if not db.get_session(sid): raise _404('会话')
    record = running_for_session(sid)
    return {'job_id': record['id'] if record else None}


class CancelRunBody(BaseModel):
    request_id: str = Field(min_length=1,max_length=64)


@router.post('/sessions/{sid}/cancel')
async def cancel_session_request(sid: str, body: CancelRunBody):
    from ...atelier import store
    from ...atelier.jobs import active
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
    from ...atelier.jobs import start_agent, stream_agent, running_for_session
    from ...atelier import providers, store
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
    gen = agent.run_agent(session_id=sid, page_id=body.page_id, doc=db.normalize_doc(body.doc), view=body.view,
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


