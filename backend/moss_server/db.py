"""SQLite 工作区：系列 / 分页 / 版本记录 / Agent 会话与消息 / 档案库。"""

from __future__ import annotations

import json
import copy
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from typing import Any, Iterator, Optional

from .config import DB_PATH, LEGACY_HISTORY_PATH, load_json, now_iso

_lock = threading.RLock()
MAX_REVISIONS_PER_PAGE = 200

SCHEMA = """
CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sort REAL NOT NULL DEFAULT 0,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY, series_id TEXT NOT NULL, name TEXT NOT NULL, sort REAL NOT NULL DEFAULT 0,
  doc TEXT NOT NULL, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS pages_series ON pages(series_id);
CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL, doc TEXT NOT NULL, source TEXT NOT NULL,
  summary TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS revisions_page ON revisions(page_id, created_at);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, series_id TEXT NOT NULL, title TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_series ON sessions(series_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', created_at TEXT
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
CREATE TABLE IF NOT EXISTS archive (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL, doc TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


@contextmanager
def conn() -> Iterator[sqlite3.Connection]:
    with _lock:
        c = sqlite3.connect(DB_PATH, timeout=10)
        c.row_factory = sqlite3.Row
        try:
            # journal_mode is persistent: the shared atelier.db already gets WAL
            # from storage.py, but an isolated MOSS_DATA_DIR database only gets
            # it here. Skip silently if the filesystem refuses WAL.
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA synchronous=NORMAL")
        except sqlite3.Error:
            pass
        c.execute("PRAGMA busy_timeout=10000")
        try:
            yield c
            c.commit()
        finally:
            c.close()


def _j(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def _row(r: Optional[sqlite3.Row], *json_cols: str) -> Optional[dict]:
    if r is None:
        return None
    d = dict(r)
    for k in json_cols:
        if k in d and isinstance(d[k], str):
            try:
                d[k] = json.loads(d[k])
            except json.JSONDecodeError:
                d[k] = {}
    return d


# ---------- 默认文档 ----------
def empty_layout(width: int = 1024, height: int = 1536) -> dict:
    return {
        "width": width, "height": height, "bbox_coord_space": "abs", "bbox_format": "xyxy",
        "summary": {"caption": "", "canvas": "single"}, "items": [],
        "prompt_options": {"depth": True, "perspective": False, "camera": True},
        "camera": {"enabled": False, "orbit": 0, "pitch": 0, "roll": 0, "distance": 1, "fov": 50,
                   "pan_x": 0, "pan_y": 0, "pan_z": 0},
    }


def empty_doc(kind: str = "layout", width: int = 1024, height: int = 1536) -> dict:
    return {"kind": kind if kind in ("layout", "caption") else "layout",
            "layout": empty_layout(width, height), "caption": {"caption": ""}}


def normalize_doc(doc: Any) -> dict:
    if not isinstance(doc, dict):
        return empty_doc()
    if "layout" not in doc and "caption" not in doc and "items" in doc:
        return {"kind": "layout", "layout": doc, "caption": {"caption": ""}}
    if "layout" not in doc and isinstance(doc.get("caption"), str):
        return {"kind": "caption", "layout": empty_layout(), "caption": {"caption": doc["caption"]}}
    out = empty_doc(doc.get("kind", "layout"))
    if isinstance(doc.get("layout"), dict):
        out["layout"] = doc["layout"]
    if isinstance(doc.get("caption"), dict):
        out["caption"] = {**doc["caption"], "caption": str(doc["caption"].get("caption") or "")}
    for key in ("asset_ids", "compile_target", "character_ids", "style"):
        if key in doc: out[key] = copy.deepcopy(doc[key])
    return out


# ---------- 初始化 / 迁移 ----------
def init() -> None:
    with conn() as c:
        c.executescript(SCHEMA)
        columns = {r[1] for r in c.execute("PRAGMA table_info(series)")}
        if "project_id" not in columns:
            c.execute("ALTER TABLE series ADD COLUMN project_id TEXT NOT NULL DEFAULT 'project_default'")
        n = c.execute("SELECT COUNT(*) FROM series").fetchone()[0]
        migrated = c.execute("SELECT v FROM kv WHERE k='legacy_history_migrated'").fetchone()
    if not migrated:
        _migrate_legacy_history()
    if n == 0:
        s = create_series("默认系列")
        create_page(s["id"], "第 1 页")


def _migrate_legacy_history() -> None:
    items = load_json(LEGACY_HISTORY_PATH, [])
    count = 0
    if isinstance(items, list):
        for it in items:
            if not isinstance(it, dict) or not isinstance(it.get("draft"), dict):
                continue
            add_archive(it.get("title") or "未命名", "旧版历史", normalize_doc(it["draft"]), it.get("prompt") or "")
            count += 1
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO kv(k, v) VALUES('legacy_history_migrated', ?)", (str(count),))


# ---------- 系列 / 分页 ----------
def workspace() -> dict:
    with conn() as c:
        series = [dict(r) for r in c.execute("SELECT * FROM series WHERE project_id=? ORDER BY sort, created_at", (kv_get("current_project", "project_default"),))]
        pages = [_row(r, "doc") for r in c.execute("SELECT * FROM pages ORDER BY sort, created_at")]
    by_s: dict[str, list] = {s["id"]: [] for s in series}
    for p in pages:
        by_s.setdefault(p["series_id"], []).append(p)
    for s in series:
        s["pages"] = by_s.get(s["id"], [])
    return {"series": series,"project_id":kv_get("current_project", "project_default")}


def create_series(name: str) -> dict:
    sid = new_id("s")
    now = now_iso()
    with conn() as c:
        mx = c.execute("SELECT COALESCE(MAX(sort), 0) FROM series").fetchone()[0]
        c.execute("INSERT INTO series(id,name,sort,created_at,updated_at,project_id) VALUES (?,?,?,?,?,?)", (sid, name.strip() or "新系列", mx + 1, now, now, kv_get("current_project", "project_default")))
    return {"id": sid, "name": name, "sort": mx + 1, "pages": []}


def update_series(sid: str, name: Optional[str] = None, sort: Optional[float] = None) -> None:
    with conn() as c:
        if name is not None:
            c.execute("UPDATE series SET name=?, updated_at=? WHERE id=?", (name.strip() or "系列", now_iso(), sid))
        if sort is not None:
            c.execute("UPDATE series SET sort=? WHERE id=?", (sort, sid))


def delete_series(sid: str) -> None:
    with conn() as c:
        pids = [r[0] for r in c.execute("SELECT id FROM pages WHERE series_id=?", (sid,))]
        for pid in pids:
            c.execute("DELETE FROM revisions WHERE page_id=?", (pid,))
        c.execute("DELETE FROM pages WHERE series_id=?", (sid,))
        sids = [r[0] for r in c.execute("SELECT id FROM sessions WHERE series_id=?", (sid,))]
        for x in sids:
            c.execute("DELETE FROM messages WHERE session_id=?", (x,))
        c.execute("DELETE FROM sessions WHERE series_id=?", (sid,))
        c.execute("DELETE FROM series WHERE id=?", (sid,))


def delete_project_series(project_id: str) -> int:
    """Cascade every series of a project (pages, revisions, sessions, messages)."""
    with conn() as c:
        sids = [r[0] for r in c.execute("SELECT id FROM series WHERE project_id=?", (project_id,))]
    for sid in sids:
        delete_series(sid)
    return len(sids)


def get_page(pid: str) -> Optional[dict]:
    with conn() as c:
        return _row(c.execute("SELECT * FROM pages WHERE id=?", (pid,)).fetchone(), "doc")


def series_pages(series_id: str) -> list[dict]:
    with conn() as c:
        return [_row(r, "doc") for r in c.execute(
            "SELECT * FROM pages WHERE series_id=? ORDER BY sort, created_at", (series_id,))]


def create_page(series_id: str, name: str, doc: Optional[dict] = None) -> dict:
    pid = new_id("p")
    now = now_iso()
    d = normalize_doc(doc) if doc else empty_doc()
    siblings=series_pages(series_id)
    if siblings:
        previous=siblings[-1]['doc']
        for key in ('asset_ids','character_ids','style','compile_target'):
            if key not in d and key in previous: d[key]=copy.deepcopy(previous[key])
    with conn() as c:
        mx = c.execute("SELECT COALESCE(MAX(sort), 0) FROM pages WHERE series_id=?", (series_id,)).fetchone()[0]
        c.execute("INSERT INTO pages VALUES (?,?,?,?,?,?,?)",
                  (pid, series_id, name.strip() or "新页", mx + 1, _j(d), now, now))
    return get_page(pid)  # type: ignore[return-value]


def update_page(pid: str, *, doc: Optional[dict] = None, name: Optional[str] = None,
                series_id: Optional[str] = None, sort: Optional[float] = None) -> Optional[dict]:
    now = now_iso()
    with conn() as c:
        if doc is not None:
            c.execute("UPDATE pages SET doc=?, updated_at=? WHERE id=?", (_j(normalize_doc(doc)), now, pid))
        if name is not None:
            c.execute("UPDATE pages SET name=?, updated_at=? WHERE id=?", (name.strip() or "页", now, pid))
        if series_id is not None:
            c.execute("UPDATE pages SET series_id=? WHERE id=?", (series_id, pid))
        if sort is not None:
            c.execute("UPDATE pages SET sort=? WHERE id=?", (sort, pid))
    return get_page(pid)


def delete_page(pid: str) -> None:
    with conn() as c:
        c.execute("DELETE FROM revisions WHERE page_id=?", (pid,))
        c.execute("DELETE FROM pages WHERE id=?", (pid,))


# ---------- 版本记录 ----------
def add_revision(page_id: str, doc: dict, source: str, summary: str = "") -> dict:
    rid = new_id("r")
    now = now_iso()
    with conn() as c:
        c.execute("INSERT INTO revisions VALUES (?,?,?,?,?,?)", (rid, page_id, _j(doc), source, summary[:200], now))
        ids = [r[0] for r in c.execute(
            "SELECT id FROM revisions WHERE page_id=? ORDER BY created_at DESC, rowid DESC", (page_id,))]
        for old in ids[MAX_REVISIONS_PER_PAGE:]:
            c.execute("DELETE FROM revisions WHERE id=?", (old,))
    return {"id": rid, "page_id": page_id, "source": source, "summary": summary, "created_at": now}


def list_revisions(page_id: str, limit: int = 100) -> list[dict]:
    with conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT id, page_id, source, summary, created_at FROM revisions WHERE page_id=? "
            "ORDER BY created_at DESC, rowid DESC LIMIT ?", (page_id, limit))]


def get_revision(rid: str) -> Optional[dict]:
    with conn() as c:
        return _row(c.execute("SELECT * FROM revisions WHERE id=?", (rid,)).fetchone(), "doc")


# ---------- 会话 / 消息 ----------
def list_sessions(series_id: str) -> list[dict]:
    with conn() as c:
        return [_row(r, "meta") for r in c.execute(
            "SELECT * FROM sessions WHERE series_id=? ORDER BY created_at", (series_id,))]


def get_session(sid: str) -> Optional[dict]:
    with conn() as c:
        return _row(c.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone(), "meta")


def create_session(series_id: str, title: str = "新对话") -> dict:
    sid = new_id("c")
    now = now_iso()
    with conn() as c:
        c.execute("INSERT INTO sessions VALUES (?,?,?,?,?,?,?)", (sid, series_id, title, 0, "{}", now, now))
    return get_session(sid)  # type: ignore[return-value]


def update_session(sid: str, *, title: Optional[str] = None, closed: Optional[bool] = None,
                   meta: Optional[dict] = None) -> Optional[dict]:
    with conn() as c:
        if title is not None:
            c.execute("UPDATE sessions SET title=? WHERE id=?", (title.strip()[:60] or "对话", sid))
        if closed is not None:
            c.execute("UPDATE sessions SET closed=? WHERE id=?", (1 if closed else 0, sid))
        if meta is not None:
            c.execute("UPDATE sessions SET meta=?, updated_at=? WHERE id=?", (_j(meta), now_iso(), sid))
    return get_session(sid)


def delete_session(sid: str) -> None:
    with conn() as c:
        c.execute("DELETE FROM messages WHERE session_id=?", (sid,))
        c.execute("DELETE FROM sessions WHERE id=?", (sid,))


def list_messages(session_id: str) -> list[dict]:
    with conn() as c:
        return [_row(r, "meta") for r in c.execute(
            "SELECT * FROM messages WHERE session_id=? ORDER BY seq", (session_id,))]


def add_message(session_id: str, role: str, content: str, meta: Optional[dict] = None) -> dict:
    mid = new_id("m")
    now = now_iso()
    with conn() as c:
        seq = c.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE session_id=?", (session_id,)).fetchone()[0]
        c.execute("INSERT INTO messages VALUES (?,?,?,?,?,?,?)",
                  (mid, session_id, seq, role, content, _j(meta or {}), now))
        c.execute("UPDATE sessions SET updated_at=? WHERE id=?", (now, session_id))
    return {"id": mid, "session_id": session_id, "seq": seq, "role": role, "content": content,
            "meta": meta or {}, "created_at": now}


def get_message(mid: str) -> Optional[dict]:
    with conn() as c:
        return _row(c.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone(), "meta")


def update_message(mid: str, *, content: Optional[str] = None, meta: Optional[dict] = None) -> Optional[dict]:
    with conn() as c:
        if content is not None:
            c.execute("UPDATE messages SET content=? WHERE id=?", (content, mid))
        if meta is not None:
            c.execute("UPDATE messages SET meta=? WHERE id=?", (_j(meta), mid))
    return get_message(mid)


def delete_messages_from(session_id: str, seq: int) -> None:
    with conn() as c:
        c.execute("DELETE FROM messages WHERE session_id=? AND seq>=?", (session_id, seq))


# ---------- 档案库 ----------
def list_archive() -> list[dict]:
    with conn() as c:
        return [_row(r, "doc") for r in c.execute("SELECT * FROM archive ORDER BY updated_at DESC")]


def add_archive(title: str, category: str, doc: dict, prompt: str = "") -> dict:
    aid = new_id("a")
    now = now_iso()
    d = normalize_doc(doc)
    with conn() as c:
        c.execute("INSERT INTO archive VALUES (?,?,?,?,?,?,?,?)",
                  (aid, title.strip() or "未命名", category.strip(), d["kind"], _j(d), prompt, now, now))
    return {"id": aid, "title": title, "category": category, "kind": d["kind"], "doc": d,
            "prompt": prompt, "created_at": now, "updated_at": now}


def update_archive(aid: str, title: Optional[str] = None, category: Optional[str] = None) -> None:
    with conn() as c:
        if title is not None:
            c.execute("UPDATE archive SET title=?, updated_at=? WHERE id=?", (title.strip() or "未命名", now_iso(), aid))
        if category is not None:
            c.execute("UPDATE archive SET category=?, updated_at=? WHERE id=?", (category.strip(), now_iso(), aid))


def delete_archive(aid: str) -> None:
    with conn() as c:
        c.execute("DELETE FROM archive WHERE id=?", (aid,))


# ---------- 键值（界面状态） ----------
def kv_get(k: str, default: Any = None) -> Any:
    with conn() as c:
        r = c.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
    if not r:
        return default
    try:
        return json.loads(r[0])
    except (TypeError, ValueError):
        return default


def kv_set(k: str, v: Any) -> None:
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO kv(k, v) VALUES(?, ?)", (k, _j(v)))


def get_archive(aid: str) -> Optional[dict]:
    with conn() as c:
        return _row(c.execute("SELECT * FROM archive WHERE id=?", (aid,)).fetchone(), "doc")
