"""Skills：写法说明（system prompt 片段）的存储与接口。"""

from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .config import SKILLS_PATH, load_json, now_iso as _now_iso, save_json as _save_json

# Marker so the legacy import runs once even when it found nothing.
MIGRATED_FLAG = SKILLS_PATH.with_name(".skills-migrated")

router = APIRouter(prefix="/api/v1/moss/skills")


class SkillActiveBody(BaseModel):
    kind: str
    id: str


class SkillCreateBody(BaseModel):
    name: str
    kind: str
    description: Optional[str] = ""
    system_prompt: str


class SkillUpdateBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    system_prompt: Optional[str] = None


_load_json = load_json

LAYOUT_SYSTEM = """你是 MOSS-Image Layout 提示词助手。根据用户想法输出**严格合法**的 Layout 草稿 JSON（不要 Markdown）。
字段必须且仅能有:
width, height, bbox_coord_space:"abs", bbox_format:"xyxy",
summary:{caption, meta?, canvas?},
items:[{label:"object"|"character"|"text", caption, bbox:[x1,y1,x2,y2], text?(仅text), tags?, palette?}]
规则:
- width/height 为正整数且为 16 的倍数；使用用户给定尺寸。
- bbox 为画布左上角起的绝对像素 [x_min,y_min,x_max,y_max]，且在画布内。
- 禁止 children/parent/id 等未知字段。
- summary.caption 与各 item.caption 用英文描述可见外观（用户明确要求中文除外）；可见文字原文放 text 字段。
- items 至少 1 个；框可重叠。
只输出一个 JSON 对象。"""

CAPTION_SYSTEM = """你是 MOSS-Image Caption 提示词助手。把用户想法扩成一段连贯的图像描述。
只输出 UTF-8 JSON: {"caption":"..."}

遵循 OpenMOSS/MOSS-Image 官方 Caption 约定：
- 默认英文散文；用户明确要求中文则用中文。
- 用文字表达空间关系，不要坐标、不要 bbox、不要 Layout 字段。
- 可见文字原文引用（含标点与换行意图）；区分「要画出来的字」与参考/约束。
- 描述可见选择：主体与动作、外观、场景、构图/机位、媒介、光线、材质、色调与情绪。
- 避免堆砌质量标签、未请求的风格漂移、任意字数预算，以及不可见的过程说明。
- 保持用户主体、数量、关系、媒介、风格、排除项与拟可见文案。"""

CONTEXT_SYSTEM = """改稿风格（Agent 附加指令）：
- 先理解用户意图，信息不足时用 ask_user 给出 2–5 个选项，而不是猜。
- 改动尽量小：只动用户提到或必须联动的框，其余原样保留。
- 每次改完用一两句中文说明改了什么、为什么；纯讨论时不调用修改工具。
- 用户手动改过的地方视为用户的决定，除非用户要求，不要改回去。"""

OFFICIAL_SKILL_PROMPTS: dict[str, str] = {
    "official-caption": CAPTION_SYSTEM,
    "official-layout": LAYOUT_SYSTEM,
    "official-context": CONTEXT_SYSTEM,
}

OFFICIAL_SKILL_META: list[dict[str, Any]] = [
    {
        "id": "official-caption",
        "name": "MOSS 官方 Caption",
        "kind": "caption",
        "builtin": True,
        "description": "OpenMOSS/MOSS-Image 官方 Caption：连贯散文描述，无坐标。",
    },
    {
        "id": "official-layout",
        "name": "MOSS 官方 Layout",
        "kind": "layout",
        "builtin": True,
        "description": "OpenMOSS/MOSS-Image 官方 Layout：绝对像素 bbox 草稿 JSON。",
    },
    {
        "id": "official-context",
        "name": "Agent 改稿风格",
        "kind": "context",
        "builtin": True,
        "description": "对话改稿时的附加指令：小步修改、先问后改、尊重手动改动。",
    },
]

DEFAULT_ACTIVE = {
    "caption": "official-caption",
    "layout": "official-layout",
    "context": "official-context",
}


def _official_skills() -> list[dict[str, Any]]:
    now = _now_iso()
    out: list[dict[str, Any]] = []
    for meta in OFFICIAL_SKILL_META:
        sid = meta["id"]
        out.append(
            {
                **meta,
                "system_prompt": OFFICIAL_SKILL_PROMPTS[sid],
                "updated_at": now,
            }
        )
    return out


def _normalize_skills_store(raw: Any) -> dict[str, Any]:
    skills = _official_skills()
    by_id = {s["id"]: s for s in skills}
    active = dict(DEFAULT_ACTIVE)
    if isinstance(raw, dict):
        custom = raw.get("skills")
        if isinstance(custom, list):
            for item in custom:
                if not isinstance(item, dict):
                    continue
                sid = item.get("id")
                if not sid or not isinstance(sid, str):
                    continue
                if sid in by_id and by_id[sid].get("builtin"):
                    # Builtins are seeded from code only when absent. Whatever is
                    # on disk wins, so an edited builtin is never silently reset.
                    if isinstance(item.get("name"), str) and item["name"].strip():
                        by_id[sid]["name"] = item["name"].strip()
                    if "description" in item:
                        by_id[sid]["description"] = str(item.get("description") or "")
                    prompt = item.get("system_prompt")
                    if isinstance(prompt, str) and prompt.strip():
                        by_id[sid]["system_prompt"] = prompt
                    if item.get("updated_at"):
                        by_id[sid]["updated_at"] = item["updated_at"]
                    continue
                kind = item.get("kind")
                if kind not in ("caption", "layout", "context"):
                    continue
                name = (item.get("name") or "").strip() or "未命名 Skill"
                prompt = item.get("system_prompt")
                if not isinstance(prompt, str) or not prompt.strip():
                    continue
                by_id[sid] = {
                    "id": sid,
                    "name": name,
                    "kind": kind,
                    "builtin": False,
                    "description": str(item.get("description") or ""),
                    "system_prompt": prompt,
                    "updated_at": item.get("updated_at") or _now_iso(),
                }
        act = raw.get("active")
        if isinstance(act, dict):
            for k in ("caption", "layout", "context"):
                aid = act.get(k)
                if isinstance(aid, str) and aid in by_id and by_id[aid]["kind"] == k:
                    active[k] = aid
    # ensure active points to existing skill of correct kind
    for k, oid in DEFAULT_ACTIVE.items():
        sid = active.get(k)
        if not sid or sid not in by_id or by_id[sid]["kind"] != k:
            active[k] = oid
    ordered = []
    for meta in OFFICIAL_SKILL_META:
        ordered.append(by_id[meta["id"]])
    for sid, s in by_id.items():
        if not s.get("builtin"):
            ordered.append(s)
    return {"skills": ordered, "active": active}


def _legacy_skill_sources() -> list[Path]:
    """Skill stores written by the standalone studio this workspace absorbed.

    The data directory moved from <studio>/data to ~/llama-manager/moss with no
    migration, so users' custom skills (one is ~48k characters) were invisible.
    """
    from .config import RES_ROOT

    candidates = [RES_ROOT.parent / "temp" / "moss-prompt-editor" / "data" / "skills.json"]
    return [path for path in candidates if path.exists()]


def _migrate_legacy_skills(store: dict[str, Any]) -> dict[str, Any]:
    """Merge custom skills from the old standalone store; existing entries win."""
    if MIGRATED_FLAG.exists():
        return store
    by_id = {s["id"]: s for s in store["skills"]}
    imported = 0
    for path in _legacy_skill_sources():
        raw = _load_json(path, None)
        if not isinstance(raw, dict):
            continue
        for item in raw.get("skills") or []:
            if not isinstance(item, dict) or item.get("builtin"):
                continue
            sid = item.get("id")
            if not isinstance(sid, str) or sid in by_id:
                continue
            kind = item.get("kind")
            prompt = item.get("system_prompt")
            if kind not in ("caption", "layout", "context") or not isinstance(prompt, str) or not prompt.strip():
                continue
            entry = {
                "id": sid,
                "name": (item.get("name") or "").strip() or "未命名 Skill",
                "kind": kind,
                "builtin": False,
                "description": str(item.get("description") or ""),
                "system_prompt": prompt,
                "updated_at": item.get("updated_at") or _now_iso(),
            }
            by_id[sid] = entry
            store["skills"].append(entry)
            imported += 1
        # Carry the old active selection over when the id now exists.
        act = raw.get("active")
        if isinstance(act, dict):
            for k in ("caption", "layout", "context"):
                aid = act.get(k)
                if isinstance(aid, str) and aid in by_id and by_id[aid]["kind"] == k:
                    store["active"][k] = aid
    try:
        MIGRATED_FLAG.parent.mkdir(parents=True, exist_ok=True)
        MIGRATED_FLAG.write_text(str(imported), encoding="utf-8")
    except OSError:
        pass
    if imported:
        _save_json(SKILLS_PATH, store)
    return store


def load_skills() -> dict[str, Any]:
    raw = _load_json(SKILLS_PATH, None)
    if raw is None and SKILLS_PATH.exists():
        # Unreadable file: keep a backup and refuse to overwrite, so a corrupt
        # store can never destroy the user's custom skills.
        backup = SKILLS_PATH.with_suffix(f".corrupt-{int(time.time())}.json")
        try:
            backup.write_bytes(SKILLS_PATH.read_bytes())
        except OSError:
            pass
        raise HTTPException(status_code=500, detail=f"skills.json 无法解析，已备份到 {backup.name}")
    store = _normalize_skills_store(raw)
    store = _migrate_legacy_skills(store)
    if raw is None and not SKILLS_PATH.exists():
        _save_json(SKILLS_PATH, store)
    return store


def save_skills(store: dict[str, Any]) -> dict[str, Any]:
    store = _normalize_skills_store(store)
    _save_json(SKILLS_PATH, store)
    return store


def get_skill(skill_id: str) -> dict[str, Any]:
    store = load_skills()
    for s in store["skills"]:
        if s["id"] == skill_id:
            return s
    raise HTTPException(status_code=404, detail=f"Skill 不存在: {skill_id}")


def resolve_skill(kind: str, skill_id: Optional[str] = None) -> dict[str, Any]:
    store = load_skills()
    if skill_id:
        for s in store["skills"]:
            if s["id"] == skill_id:
                if s["kind"] != kind:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Skill {skill_id} 类型为 {s['kind']}，需要 {kind}",
                    )
                return s
        raise HTTPException(status_code=404, detail=f"Skill 不存在: {skill_id}")
    active_id = store["active"].get(kind) or DEFAULT_ACTIVE[kind]
    for s in store["skills"]:
        if s["id"] == active_id:
            return s
    # fallback official
    for s in store["skills"]:
        if s["id"] == DEFAULT_ACTIVE[kind]:
            return s
    raise HTTPException(status_code=500, detail=f"缺少默认 skill: {kind}")


@router.get("")
def api_list_skills():
    store = load_skills()
    return store


@router.put("/active")
def api_set_active_skill(body: SkillActiveBody):
    kind = body.kind
    if kind not in ("caption", "layout", "context"):
        raise HTTPException(status_code=400, detail="kind 必须是 caption|layout|context")
    store = load_skills()
    skill = None
    for s in store["skills"]:
        if s["id"] == body.id:
            skill = s
            break
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill 不存在: {body.id}")
    if skill["kind"] != kind:
        raise HTTPException(status_code=400, detail=f"Skill 类型为 {skill['kind']}，不能设为 {kind}")
    store["active"][kind] = body.id
    store = save_skills(store)
    return store


@router.post("")
def api_create_skill(body: SkillCreateBody):
    kind = body.kind
    if kind not in ("caption", "layout", "context"):
        raise HTTPException(status_code=400, detail="kind 必须是 caption|layout|context")
    name = (body.name or "").strip()
    prompt = (body.system_prompt or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name 必填")
    if not prompt:
        raise HTTPException(status_code=400, detail="system_prompt 必填")
    store = load_skills()
    sid = f"custom-{uuid.uuid4().hex[:10]}"
    skill = {
        "id": sid,
        "name": name,
        "kind": kind,
        "builtin": False,
        "description": (body.description or "").strip(),
        "system_prompt": prompt,
        "updated_at": _now_iso(),
    }
    store["skills"].append(skill)
    store = save_skills(store)
    return {"skill": skill, **{k: store[k] for k in ("skills", "active")}}


@router.put("/{skill_id}")
def api_update_skill(skill_id: str, body: SkillUpdateBody):
    store = load_skills()
    idx = next((i for i, s in enumerate(store["skills"]) if s["id"] == skill_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail=f"Skill 不存在: {skill_id}")
    skill = dict(store["skills"][idx])
    data = body.model_dump(exclude_none=True)
    # Builtin prompts are editable too: the shipped text is only a seed, and
    # "重置" restores it. Users asked for their skill text to survive verbatim.
    if "name" in data:
        name = str(data["name"]).strip()
        if not name:
            raise HTTPException(status_code=400, detail="name 不能为空")
        skill["name"] = name
    if "description" in data:
        skill["description"] = str(data["description"])
    if "system_prompt" in data:
        prompt = str(data["system_prompt"]).strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="system_prompt 不能为空")
        skill["system_prompt"] = prompt
    skill["updated_at"] = _now_iso()
    store["skills"][idx] = skill
    store = save_skills(store)
    return {"skill": skill, "skills": store["skills"], "active": store["active"]}


@router.post("/{skill_id}/reset")
def api_reset_skill(skill_id: str):
    if skill_id not in OFFICIAL_SKILL_PROMPTS:
        raise HTTPException(status_code=400, detail="仅内置 Skill 可重置")
    store = load_skills()
    idx = next((i for i, s in enumerate(store["skills"]) if s["id"] == skill_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail=f"Skill 不存在: {skill_id}")
    skill = dict(store["skills"][idx])
    if not skill.get("builtin"):
        raise HTTPException(status_code=400, detail="仅内置 Skill 可重置")
    meta = next(m for m in OFFICIAL_SKILL_META if m["id"] == skill_id)
    skill["name"] = meta["name"]
    skill["description"] = meta["description"]
    skill["system_prompt"] = OFFICIAL_SKILL_PROMPTS[skill_id]
    skill["updated_at"] = _now_iso()
    store["skills"][idx] = skill
    store = save_skills(store)
    return {"skill": skill, "skills": store["skills"], "active": store["active"]}


@router.post("/{skill_id}/duplicate")
def api_duplicate_skill(skill_id: str):
    store = load_skills()
    src = next((s for s in store["skills"] if s["id"] == skill_id), None)
    if not src:
        raise HTTPException(status_code=404, detail=f"Skill 不存在: {skill_id}")
    sid = f"custom-{uuid.uuid4().hex[:10]}"
    skill = {
        "id": sid,
        "name": f"{src['name']} 副本",
        "kind": src["kind"],
        "builtin": False,
        "description": src.get("description") or "",
        "system_prompt": src["system_prompt"],
        "updated_at": _now_iso(),
    }
    store["skills"].append(skill)
    store = save_skills(store)
    return {"skill": skill, "skills": store["skills"], "active": store["active"]}


@router.delete("/{skill_id}")
def api_delete_skill(skill_id: str):
    store = load_skills()
    skill = next((s for s in store["skills"] if s["id"] == skill_id), None)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill 不存在: {skill_id}")
    if skill.get("builtin"):
        raise HTTPException(status_code=400, detail="内置 Skill 不可删除")
    kind = skill["kind"]
    store["skills"] = [s for s in store["skills"] if s["id"] != skill_id]
    if store["active"].get(kind) == skill_id:
        store["active"][kind] = DEFAULT_ACTIVE[kind]
    store = save_skills(store)
    return store


