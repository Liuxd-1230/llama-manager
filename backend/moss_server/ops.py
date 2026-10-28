"""Agent 工具 → 对工作副本的修改。坐标换算、千分比识别、等比摆放、名字继承都在这里做，不让模型心算。"""

from __future__ import annotations

import copy
import json
import math
import uuid
from typing import Any, Optional

from . import db
from .layout_core import _is_cjk, sanitize_body, sanitize_camera, _ensure_wh
from .lighting import (PRESET_BY_ID, PRESETS, ROLES, _wrap, default_lighting, describe_lighting, lighting_phrase,
                       preset_lighting, sanitize_light, sanitize_lighting)

LABELS = ("object", "character", "text")
DEPTHS = ("auto", "fg", "mg", "bg")
CANVAS_KINDS = ("single", "multi_panel", "collage")


class ToolError(Exception):
    pass


def new_item_id() -> str:
    return "b" + uuid.uuid4().hex[:8]


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)) and math.isfinite(v):
        return float(v)
    if isinstance(v, str):
        try:
            f = float(v)
            return f if math.isfinite(f) else None
        except ValueError:
            return None
    return None


def _bbox4(v: Any) -> Optional[list[float]]:
    if not isinstance(v, (list, tuple)) or len(v) != 4:
        return None
    out = [_num(x) for x in v]
    if any(x is None for x in out):
        return None
    return out  # type: ignore[return-value]


def clamp_bbox(b: list[float], w: int, h: int) -> list[int]:
    x1, y1, x2, y2 = b
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    x1 = int(round(max(0, min(x1, w - 4))))
    y1 = int(round(max(0, min(y1, h - 4))))
    x2 = int(round(max(x1 + 4, min(x2, w))))
    y2 = int(round(max(y1 + 4, min(y2, h))))
    return [x1, y1, x2, y2]


def _strs(v: Any) -> Optional[list[str]]:
    if isinstance(v, str):
        v = [x.strip() for x in v.split(",")]
    if not isinstance(v, list):
        return None
    out = [str(x).strip() for x in v if isinstance(x, (str, int, float)) and str(x).strip()]
    return out


def item_name(it: dict) -> str:
    return (it.get("name") or "").strip() or (it.get("text") or "").strip()[:16] or (it.get("caption") or "").strip()[:16] or it.get("id", "?")


def find_item(items: list[dict], ref: Any) -> int:
    if isinstance(ref, (int, float)) and not isinstance(ref, bool):
        i = int(ref) - 1
        if 0 <= i < len(items):
            return i
        raise ToolError(f"没有第 {int(ref)} 层")
    r = str(ref or "").strip()
    if not r:
        raise ToolError("ref 为空")
    for i, it in enumerate(items):
        if it.get("id") == r:
            return i
    for i, it in enumerate(items):
        if (it.get("name") or "").strip() == r:
            return i
    low = r.casefold()
    for i, it in enumerate(items):
        if (it.get("name") or "").strip().casefold() == low:
            return i
    if r.startswith("#") and r[1:].isdigit():
        i = int(r[1:]) - 1
        if 0 <= i < len(items):
            return i
    hits = [i for i, it in enumerate(items) if low and low in (it.get("name") or "").casefold()]
    if len(hits) == 1:
        return hits[0]
    raise ToolError(f"找不到框「{r}」（可用 id、名称或 #层号）")


def _apply_fields(it: dict, inp: dict, w: int, h: int, *, is_new: bool) -> list[str]:
    changed: list[str] = []
    if inp.get('shape') in ('rectangle','ellipse','polygon'):
        it['shape']=inp['shape']
    if isinstance(inp.get('points'),list) and len(inp['points'])>=3:
        points=inp['points']
        if any(not isinstance(p,list) or len(p)!=2 or any(not isinstance(v,(int,float)) or not 0<=v<=1 for v in p) for p in points): raise ToolError('顶点坐标必须在 0 到 1 之间')
        it['points']=copy.deepcopy(points)
    if "label" in inp and inp["label"] in LABELS and inp["label"] != it.get("label"):
        it["label"] = inp["label"]
        changed.append("类型")
    if "name" in inp and isinstance(inp["name"], str):
        nm = inp["name"].strip()[:80]
        if nm != (it.get("name") or ""):
            it["name"] = nm
            changed.append("名称")
    if "caption" in inp and isinstance(inp["caption"], str):
        if inp["caption"].strip() != it.get("caption"):
            it["caption"] = inp["caption"].strip()
            changed.append("描述")
    if "text" in inp:
        t = inp["text"]
        if isinstance(t, str) and t.strip():
            if t != it.get("text"):
                it["text"] = t
                changed.append("文字")
        elif t in (None, "") and "text" in it:
            it.pop("text", None)
            changed.append("文字")
    for key, zh in (("tags", "标签"), ("palette", "色板")):
        if key in inp:
            v = _strs(inp[key])
            if v:
                it[key] = v
            else:
                it.pop(key, None)
            changed.append(zh)
    if "depth" in inp and inp["depth"] in DEPTHS and inp["depth"] != it.get("depth"):
        it["depth"] = inp["depth"]
        changed.append("景深")
    if "hidden" in inp and isinstance(inp["hidden"], bool) and inp["hidden"] != bool(it.get("hidden")):
        it["hidden"] = inp["hidden"]
        changed.append("显隐")
    if "bbox" in inp:
        b = _bbox4(inp["bbox"])
        if b is None:
            raise ToolError("bbox 必须是 [x1,y1,x2,y2] 四个数字（画布左上角原点的绝对像素）")
        nb = clamp_bbox(b, w, h)
        if nb != it.get("bbox"):
            it["bbox"] = nb
            changed.append("位置")
    if "group" in inp:
        g = inp["group"]
        g = g.strip()[:40] if isinstance(g, str) else ""
        if g and g != it.get("group"):
            it["group"] = g
            changed.append("成组")
        elif not g and it.get("group"):
            it.pop("group", None)
            changed.append("成组")
    if "body" in inp and isinstance(inp["body"], dict):
        nb = sanitize_body({**(it.get("body") or {}), **inp["body"]})
        if nb != it.get("body"):
            it["body"] = nb
            changed.append("体块")
    if is_new:
        if "bbox" not in it:
            raise ToolError("新框缺少 bbox")
        it.setdefault("label", "object")
        it.setdefault("caption", "")
        if it["label"] == "text" and not (it.get("text") or "").strip():
            it["text"] = it.get("caption") or ""
    return changed


def _scale_bbox(b: list[float], sx: float, sy: float, ox: float = 0, oy: float = 0) -> list[float]:
    return [b[0] * sx + ox, b[1] * sy + oy, b[2] * sx + ox, b[3] * sy + oy]


def _fit(b: list[float], w: float, h: float, tw: int, th: int) -> list[float]:
    """按 w×h 写的框等比缩放后摆在 tw×th 画布正中，形状不变。
    横贯全宽的框（背景、横幅标题）左右撑到画布边，纵贯全高的上下撑满。"""
    s = min(tw / w, th / h)
    ox, oy = (tw - w * s) / 2, (th - h * s) / 2
    x1, y1, x2, y2 = b[0] * s + ox, b[1] * s + oy, b[2] * s + ox, b[3] * s + oy
    if b[2] - b[0] >= 0.9 * w:
        x1, x2 = (0 if b[0] <= 0.02 * w else x1), (tw if b[2] >= 0.98 * w else x2)
    if b[3] - b[1] >= 0.9 * h:
        y1, y2 = (0 if b[1] <= 0.02 * h else y1), (th if b[3] >= 0.98 * h else y2)
    return [x1, y1, x2, y2]


def normalize_coords(boxes: list[list[float]], w: int, h: int, declared: Optional[tuple[float, float]]) -> tuple[list[list[float]], str]:
    """识别 0–1 归一化 / 0–1000 千分比 / 其他画布尺寸写的坐标，换算到当前画布绝对像素。"""
    if not boxes:
        return boxes, ""
    flat = [v for b in boxes for v in b]
    mx = max(flat)
    if all(0 <= v <= 1.0 for v in flat) and mx <= 1.0:
        return [_scale_bbox(b, w, h) for b in boxes], "检测到 0–1 归一化坐标，已换算成像素"
    if declared and (declared[0], declared[1]) != (w, h) and declared[0] > 0 and declared[1] > 0:
        dw, dh = declared
        return [_fit(b, dw, dh, w, h) for b in boxes], f"按 {int(dw)}×{int(dh)} 写的布局已等比缩放并居中到 {w}×{h}"
    over = any(b[2] > w * 1.1 or b[3] > h * 1.1 for b in boxes)
    if over and all(0 <= v <= 1000 for v in flat):
        return [_scale_bbox(b, w / 1000, h / 1000) for b in boxes], "检测到 0–1000 千分比坐标，已换算成像素"
    return boxes, ""


def inherit_meta(old: list[dict], fresh: list[dict]) -> None:
    """先按名字对号；没对上的，块数相同时接离中心最近、还没被认领的旧框（模型常把先后换了）。"""
    taken: set[int] = set()
    match: list[Optional[int]] = [None] * len(fresh)
    names = {(o.get("name") or "").strip(): i for i, o in enumerate(old) if (o.get("name") or "").strip()}
    for i, f in enumerate(fresh):
        nm = (f.get("name") or "").strip()
        if nm and nm in names and names[nm] not in taken:
            match[i] = names[nm]
            taken.add(names[nm])
    if len(old) == len(fresh):
        def center(b: list) -> tuple[float, float]:
            return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
        for i, f in enumerate(fresh):
            if match[i] is not None:
                continue
            fc = center(f["bbox"])
            best, bd = None, 1e18
            for j, o in enumerate(old):
                if j in taken:
                    continue
                oc = center(o["bbox"])
                d = (fc[0] - oc[0]) ** 2 + (fc[1] - oc[1]) ** 2
                if d < bd:
                    best, bd = j, d
            if best is not None:
                match[i] = best
                taken.add(best)
    for i, f in enumerate(fresh):
        j = match[i]
        if j is None:
            continue
        o = old[j]
        f["id"] = o.get("id") or f.get("id")
        for k in ("color", "depth", "body", "name", "group"):
            if k not in f and k in o:
                f[k] = copy.deepcopy(o[k])


class Workbench:
    """一轮 Agent 运行内的工作副本。所有工具都改这里；结束后和原稿对比，生成待确认改动。"""

    def __init__(self, series_id: str, page_id: str):
        self.series_id = series_id
        self.target = page_id
        self.base: dict[str, dict] = {}
        self.working: dict[str, dict] = {}
        self.names: dict[str, str] = {}
        self.created: list[dict] = []
        self.ask: Optional[dict] = None
        for p in db.series_pages(series_id):
            self.names[p["id"]] = p["name"]
            self.base[p["id"]] = db.normalize_doc(p["doc"])

    def set_current_doc(self, page_id: str, doc: dict) -> None:
        self.base[page_id] = db.normalize_doc(copy.deepcopy(doc))

    def doc(self, pid: Optional[str] = None) -> dict:
        pid = pid or self.target
        if pid not in self.working:
            if pid not in self.base:
                p = db.get_page(pid)
                if not p:
                    raise ToolError(f"页面不存在: {pid}")
                self.base[pid] = db.normalize_doc(p["doc"])
                self.names[pid] = p["name"]
            self.working[pid] = copy.deepcopy(self.base[pid])
        return self.working[pid]

    def layout(self, activate: bool = True) -> dict:
        d = self.doc()
        if activate:
            d["kind"] = "layout"
        return d["layout"]

    def changed_pages(self) -> list[str]:
        out = []
        for pid, d in self.working.items():
            if json.dumps(d, sort_keys=True) != json.dumps(self.base.get(pid), sort_keys=True):
                out.append(pid)
        return out

    def _next_color(self, items: list[dict]) -> int:
        used = [it.get("color") for it in items if isinstance(it.get("color"), int)]
        return (max(used) + 1) % 6 if used else len(items) % 6

    # ---------- 工具 ----------
    def run(self, name: str, args: dict) -> str:
        fn = getattr(self, f"t_{name}", None)
        if fn is None:
            raise ToolError(f"未知工具 {name}")
        if not isinstance(args, dict):
            raise ToolError("参数必须是 JSON 对象")
        return fn(**{k: v for k, v in args.items() if isinstance(k, str)})

    def t_update_summary(self, caption: Any = None, meta: Any = None, canvas: Any = None, palette: Any = None, **_: Any) -> str:
        L = self.layout()
        s = L.setdefault("summary", {"caption": ""})
        done = []
        if isinstance(caption, str):
            s["caption"] = caption.strip()
            done.append("整体描述")
        if meta is not None:
            v = _strs(meta)
            if v:
                s["meta"] = v
            else:
                s.pop("meta", None)
            done.append("类型词")
        if canvas in CANVAS_KINDS:
            s["canvas"] = canvas
            done.append("画布类型")
        if palette is not None:
            v = _strs(palette)
            if v:
                s["palette"] = v
            else:
                s.pop("palette", None)
            done.append("色板")
        return "已更新：" + "、".join(done) if done else "没有可更新的字段"

    def t_add_items(self, items: Any = None, **_: Any) -> str:
        if not isinstance(items, list) or not items:
            raise ToolError("items 必须是非空数组")
        L = self.layout()
        cur = L.setdefault("items", [])
        w, h = L["width"], L["height"]
        boxes = [_bbox4(x.get("bbox")) if isinstance(x, dict) else None for x in items]
        if any(b is None for b in boxes):
            raise ToolError("每个新框都要有 bbox [x1,y1,x2,y2]")
        conv, note = normalize_coords(boxes, w, h, None)  # type: ignore[arg-type]
        names = []
        for inp, b in zip(items, conv):
            it: dict[str, Any] = {"id": new_item_id(), "color": self._next_color(cur), "depth": "auto"}
            _apply_fields(it, {**inp, "bbox": b}, w, h, is_new=True)
            pos = inp.get("insert_at")
            if isinstance(pos, int) and 1 <= pos <= len(cur) + 1:
                cur.insert(pos - 1, it)
            else:
                cur.append(it)
            names.append(f"「{item_name(it)}」id={it['id']}")
        return f"已新增 {len(names)} 个框：" + "，".join(names) + (f"（{note}）" if note else "")

    def t_update_items(self, updates: Any = None, **_: Any) -> str:
        if not isinstance(updates, list) or not updates:
            raise ToolError("updates 必须是非空数组")
        L = self.layout()
        items = L.setdefault("items", [])
        w, h = L["width"], L["height"]
        out, errs = [], []
        for u in updates:
            if not isinstance(u, dict):
                continue
            try:
                i = find_item(items, u.get("ref"))
                it = items[i]
                if it.get("locked"):
                    raise ToolError(f"「{item_name(it)}」已锁定，不能修改")
                ch = _apply_fields(it, u, w, h, is_new=False)
                out.append(f"「{item_name(it)}」{'/'.join(ch) or '无变化'}")
            except ToolError as e:
                errs.append(str(e))
        msg = "已修改：" + "；".join(out) if out else "没有修改"
        if errs:
            msg += "。失败：" + "；".join(errs)
        if not out and errs:
            raise ToolError(msg)
        return msg

    def t_remove_items(self, refs: Any = None, **_: Any) -> str:
        if isinstance(refs, (str, int)):
            refs = [refs]
        if not isinstance(refs, list) or not refs:
            raise ToolError("refs 必须是非空数组")
        L = self.layout()
        items = L.setdefault("items", [])
        kill, errs = set(), []
        for r in refs:
            try:
                i = find_item(items, r)
                if items[i].get("locked"):
                    errs.append(f"「{item_name(items[i])}」已锁定")
                else:
                    kill.add(i)
            except ToolError as e:
                errs.append(str(e))
        names = [item_name(items[i]) for i in sorted(kill)]
        L["items"] = [it for i, it in enumerate(items) if i not in kill]
        msg = f"已删除 {len(names)} 个框：" + "、".join(names)
        if errs:
            msg += "。未删除：" + "；".join(errs)
        if not kill:
            raise ToolError(msg)
        return msg

    def t_reorder_items(self, order: Any = None, **_: Any) -> str:
        if not isinstance(order, list) or len(order) < 2:
            raise ToolError("order 至少列出 2 个框（从后到前）")
        L = self.layout()
        items = L.setdefault("items", [])
        idx = []
        for r in order:
            i = find_item(items, r)
            if i not in idx:
                idx.append(i)
        slots = sorted(idx)
        new = list(items)
        for slot, src in zip(slots, idx):
            new[slot] = items[src]
        L["items"] = new
        return "已调整图层顺序（从后到前）：" + " → ".join(item_name(items[i]) for i in idx)

    def t_replace_layout(self, summary: Any = None, items: Any = None, width: Any = None, height: Any = None,
                         resize_canvas: Any = False, **_: Any) -> str:
        if not isinstance(items, list) or not items:
            raise ToolError("items 必须是非空数组")
        L = self.layout()
        notes = []
        dw, dh = _num(width), _num(height)
        if resize_canvas and dw and dh:
            nw, nh = _ensure_wh(int(max(256, min(4096, dw))), int(max(256, min(4096, dh))))
            if (nw, nh) != (L["width"], L["height"]):
                notes.append(f"画布改为 {nw}×{nh}")
            L["width"], L["height"] = nw, nh
            declared = None
        else:
            declared = (dw, dh) if dw and dh else None
        w, h = L["width"], L["height"]
        boxes = [_bbox4(x.get("bbox")) if isinstance(x, dict) else None for x in items]
        if any(b is None for b in boxes):
            raise ToolError("每个框都要有 bbox [x1,y1,x2,y2]")
        conv, note = normalize_coords(boxes, w, h, declared)  # type: ignore[arg-type]
        if note:
            notes.append(note)
        old = L.get("items") or []
        fresh = []
        for k, (inp, b) in enumerate(zip(items, conv)):
            it: dict[str, Any] = {"id": new_item_id()}
            _apply_fields(it, {**inp, "bbox": b}, w, h, is_new=True)
            fresh.append(it)
        inherit_meta(old, fresh)
        used = {it["id"] for it in fresh}
        # 锁定的旧框原样保留在原来的层位
        for j, o in enumerate(old):
            if o.get("locked") and o.get("id") not in used:
                fresh.insert(min(j, len(fresh)), copy.deepcopy(o))
                notes.append(f"保留锁定框「{item_name(o)}」")
        for k, it in enumerate(fresh):
            it.setdefault("color", k % 6)
            it.setdefault("depth", "auto")
        L["items"] = fresh
        if isinstance(summary, dict):
            self.t_update_summary(**summary)
        elif isinstance(summary, str):
            self.t_update_summary(caption=summary)
        return f"已写入布局：{len(fresh)} 个框" + (f"（{'；'.join(notes)}）" if notes else "")

    def t_set_canvas_size(self, width: Any = None, height: Any = None, scale_items: Any = True, **_: Any) -> str:
        dw, dh = _num(width), _num(height)
        if not dw or not dh:
            raise ToolError("需要 width 和 height")
        L = self.layout()
        ow, oh = L["width"], L["height"]
        nw, nh = _ensure_wh(int(max(256, min(4096, dw))), int(max(256, min(4096, dh))))
        L["width"], L["height"] = nw, nh
        if scale_items is not False:
            for it in L.get("items") or []:
                it["bbox"] = clamp_bbox(_scale_bbox(it["bbox"], nw / ow, nh / oh), nw, nh)
        return f"画布 {ow}×{oh} → {nw}×{nh}" + ("，框已按比例缩放" if scale_items is not False else "")

    def t_set_camera(self, **kw: Any) -> str:
        L = self.layout()
        cur = L.get("camera") or {}
        merged = {**cur, **{k: v for k, v in kw.items() if v is not None}}
        if "enabled" not in kw:
            merged["enabled"] = True
        cam = sanitize_camera(merged)
        L["camera"] = cam
        return "摄像机：" + ("开启 " if cam["enabled"] else "关闭 ") + ", ".join(
            f"{k}={cam[k]}" for k in ("orbit", "pitch", "roll", "distance", "fov", "pan_x", "pan_y", "pan_z"))

    def t_set_lighting(self, enabled: Any = None, preset: Any = None, lights: Any = None, update_lights: Any = None,
                       remove_lights: Any = None, ambient: Any = None, ambient_kelvin: Any = None, extras: Any = None,
                       note: Any = None, follow_camera: Any = None, **_: Any) -> str:
        L = self.layout()
        cam = L.get("camera") or {}
        cam_on = bool(cam.get("enabled"))
        orbit = float(cam.get("orbit") or 0) if cam_on else 0.0
        lg = sanitize_lighting(L.get("lighting")) or default_lighting()
        notes: list[str] = []
        if isinstance(follow_camera, bool) and follow_camera != lg["follow"]:
            # 切换参照系时换算存储的方位，灯在场景里不跳
            for l in lg["lights"]:
                l["azimuth"] = _wrap(l["azimuth"] + (-orbit if follow_camera else orbit))
            lg["follow"] = follow_camera
        off = 0.0 if lg["follow"] else orbit  # 工具里的方位相对当前机位，存储时换算
        if preset not in (None, ""):
            p = preset_lighting(preset, cam if cam_on else None, lg)
            if not p:
                raise ToolError("没有这个灯光预设。可用：" + "、".join(f"{x['id']}（{x['name']}）" for x in PRESETS))
            lg = p
            notes.append(f"套用预设「{PRESET_BY_ID[p['preset']]['name']}」")
        manual = False
        if isinstance(lights, list):
            fresh = []
            for i, x in enumerate(lights[:8]):
                if not isinstance(x, dict):
                    continue
                y = dict(x)
                if _num(y.get("azimuth")) is not None:
                    y["azimuth"] = float(y["azimuth"]) + off
                y.pop("id", None)
                fresh.append(sanitize_light(y, i))
            lg["lights"] = fresh
            manual = True
        if isinstance(update_lights, list):
            for x in update_lights:
                if not isinstance(x, dict):
                    continue
                ref = str(x.get("ref") or x.get("id") or x.get("role") or "").strip()
                hit = next((l for l in lg["lights"] if l["id"] == ref), None) or next(
                    (l for l in lg["lights"] if l["role"] == ref or ROLES.get(l["role"], {}).get("zh") == ref), None)
                if not hit:
                    raise ToolError(f"找不到灯「{ref}」（用灯的 id 或角色 key/fill/rim/bg/practical）")
                y = {k: v for k, v in x.items() if k not in ("ref", "id")}
                if _num(y.get("azimuth")) is not None:
                    y["azimuth"] = float(y["azimuth"]) + off
                if "color" in y and "kelvin" not in y:
                    y["kelvin"] = None
                hit.update(sanitize_light({**hit, **y}))
                manual = True
        if isinstance(remove_lights, list) and remove_lights:
            refs = {str(r) for r in remove_lights}
            before = len(lg["lights"])
            lg["lights"] = [l for l in lg["lights"] if l["id"] not in refs and l["role"] not in refs]
            manual = manual or len(lg["lights"]) != before
        if manual and preset in (None, ""):
            lg["preset"] = ""
        if _num(ambient) is not None:
            lg["ambient"] = ambient
        if _num(ambient_kelvin) is not None:
            lg["ambient_kelvin"] = ambient_kelvin
        if isinstance(extras, list):
            lg["extras"] = extras
        if isinstance(note, str):
            lg["note"] = note.strip()
        lg["enabled"] = enabled if isinstance(enabled, bool) else True
        lg = sanitize_lighting(lg)
        L["lighting"] = lg
        L.setdefault("prompt_options", {}).setdefault("lighting", True)
        zh = _is_cjk((L.get("summary") or {}).get("caption", ""))
        ph = lighting_phrase(lg, cam if cam_on else None, zh)
        return ("灯光：" + ("开启" if lg["enabled"] else "关闭") + (f"，{'；'.join(notes)}" if notes else "")
                + f"，{len(lg['lights'])} 盏灯。编译时追加：{ph or '（无）'}")

    def t_set_bodies(self, bodies: Any = None, **_: Any) -> str:
        if not isinstance(bodies, list) or not bodies:
            raise ToolError("bodies 必须是非空数组")
        L = self.layout()
        items = L.setdefault("items", [])
        out, errs = [], []
        for b in bodies:
            if not isinstance(b, dict):
                continue
            try:
                i = find_item(items, b.get("ref"))
                it = items[i]
                if it.get("locked"):
                    raise ToolError(f"「{item_name(it)}」已锁定")
                it["body"] = sanitize_body({**(it.get("body") or {}), **{k: v for k, v in b.items() if k != "ref"}})
                bd = it["body"]
                out.append(f"「{item_name(it)}」z={bd['z']} 厚={bd['thickness']} yaw={bd['yaw']} {bd['anchor']}")
            except ToolError as e:
                errs.append(str(e))
        if not out:
            raise ToolError("；".join(errs) or "没有设置任何体块")
        return "已设置体块：" + "；".join(out) + ("。失败：" + "；".join(errs) if errs else "")

    def t_update_segments(self, segments: Any = None, **_: Any) -> str:
        if not isinstance(segments,list): raise ToolError('segments 必须是数组')
        d=self.doc()
        existing=copy.deepcopy(d.get('caption',{}).get('segments') or [{'id':'initial','name':'画面','text':d.get('caption',{}).get('caption','')}])
        by_id={segment['id']:segment for segment in existing}
        for patch in segments:
            if not isinstance(patch,dict) or patch.get('id') not in by_id: raise ToolError('请使用当前成稿中的段落 id')
            segment=by_id[patch['id']]
            if segment.get('locked'): raise ToolError('固定段落不能修改')
            for key in ('text','name'):
                if key in patch: segment[key]=str(patch[key])
        d['caption']={'caption':'\n'.join(segment.get('text','') for segment in existing),'segments':existing}
        return '已提交分段修改'

    def t_set_caption(self, caption: Any = None, activate: Any = True, **_: Any) -> str:
        if not isinstance(caption, str) or not caption.strip():
            raise ToolError("caption 不能为空")
        d = self.doc()
        segments = d.get('caption',{}).get('segments') or []
        if any(segment.get('locked') for segment in segments):
            raise ToolError('成稿包含固定段落，不能整页替换；请让用户先解除固定或针对未固定段落讨论修改')
        d["caption"] = {"caption": caption.strip(), "segments": [{"id":"agent_caption", "name":"成稿", "text":caption.strip()}]}
        if activate is not False:
            d["kind"] = "caption"
        return f"已写入 Caption（{len(caption.strip())} 字符）"

    def t_create_page(self, name: Any = None, kind: Any = "layout", width: Any = None, height: Any = None, **_: Any) -> str:
        cur = self.doc()
        L = cur["layout"]
        w = int(_num(width) or L.get("width") or 1024)
        h = int(_num(height) or L.get("height") or 1536)
        w, h = _ensure_wh(max(256, min(4096, w)), max(256, min(4096, h)))
        nm = str(name or "").strip() or f"第 {len(self.names) + 1} 页"
        page = db.create_page(self.series_id, nm, db.empty_doc(kind if kind in ("layout", "caption") else "layout", w, h))
        self.names[page["id"]] = page["name"]
        self.base[page["id"]] = db.normalize_doc(page["doc"])
        self.created.append(page)
        self.target = page["id"]
        return f"已新建页面「{nm}」id={page['id']}，之后的修改都写在这一页"

    def t_switch_page(self, page: Any = None, **_: Any) -> str:
        pid = self.resolve_page(page)
        self.target = pid
        return f"已切换到页面「{self.names.get(pid, pid)}」，之后的修改写在这一页"

    def t_view_page(self, page: Any = None, **_: Any) -> str:
        pid = self.resolve_page(page)
        return describe_doc(self.doc(pid), self.names.get(pid, pid), pid)

    def resolve_page(self, page: Any) -> str:
        r = str(page or "").strip()
        if r in self.names:
            return r
        for pid, nm in self.names.items():
            if nm == r:
                return pid
        if r.isdigit():
            ids = list(self.names)
            i = int(r) - 1
            if 0 <= i < len(ids):
                return ids[i]
        raise ToolError(f"找不到页面「{r}」")


# ---------- 给模型看的紧凑状态 ----------
def compact_item(it: dict, layer: int, view: Optional[dict] = None) -> dict:
    d: dict[str, Any] = {"layer": layer, "id": it.get("id"), "name": it.get("name") or "", "label": it.get("label"),
                         "bbox": it.get("bbox"), "caption": it.get("caption") or ""}
    if it.get("text"):
        d["text"] = it["text"]
    if it.get("depth") and it["depth"] != "auto":
        d["depth"] = it["depth"]
    if it.get("body"):
        d["body"] = it["body"]
    for k in ("tags", "palette"):
        if it.get(k):
            d[k] = it[k]
    if it.get("locked"):
        d["locked"] = True
    if it.get("hidden"):
        d["hidden"] = True
    if it.get("group"):
        d["group"] = it["group"]
    if view and it.get("id") in view:
        v = view[it["id"]]
        d["view_bbox"] = v.get("bbox")
        if v.get("visible") is False:
            d["out_of_frame"] = True
    return d


def describe_doc(doc: dict, name: str, pid: str, view: Optional[dict] = None, brief: bool = False) -> str:
    d = db.normalize_doc(doc)
    if d["kind"] == "caption":
        cap = d["caption"].get("caption") or ""
        if brief:
            return f"页面「{name}」(id={pid}) Caption：{cap[:160]}"
        return json.dumps({"page": name, "page_id": pid, "kind": "caption", "caption": cap, "segments":d["caption"].get("segments",[])}, ensure_ascii=False)
    L = d["layout"]
    items = L.get("items") or []
    if brief:
        names = "、".join(item_name(it) for it in items[:12])
        return (f"页面「{name}」(id={pid}) Layout {L.get('width')}×{L.get('height')}，{len(items)} 个框（{names}）；"
                f"整体：{(L.get('summary') or {}).get('caption', '')[:120]}")
    out: dict[str, Any] = {
        "page": name, "page_id": pid, "kind": "layout",
        "canvas": {"width": L.get("width"), "height": L.get("height")},
        "summary": L.get("summary") or {},
        "layers_back_to_front": [compact_item(it, i + 1, view) for i, it in enumerate(items)],
    }
    cam = L.get("camera") or {}
    if cam.get("enabled"):
        out["camera"] = {k: cam.get(k) for k in ("orbit", "pitch", "roll", "distance", "fov", "pan_x", "pan_y", "pan_z")}
    lg = describe_lighting(L.get("lighting"), cam if cam.get("enabled") else None)
    if lg:
        out["lighting"] = lg
    p = L.get("perspective") or {}
    if p.get("enabled"):
        out["perspective"] = {k: p.get(k) for k in ("mode", "horizon_y", "vp1_x", "vp2_x", "vp3_x", "vp3_y")}
    return json.dumps(out, ensure_ascii=False)


def describe_changes(before: Optional[dict], after: dict) -> list[str]:
    """两个文档之间的人话差异：用于『用户手动改了什么』和版本记录摘要。"""
    if before is None:
        return []
    b, a = db.normalize_doc(before), db.normalize_doc(after)
    out: list[str] = []
    if b["kind"] != a["kind"]:
        out.append(f"页面类型 {b['kind']} → {a['kind']}")
    if (b["caption"].get("caption") or "") != (a["caption"].get("caption") or ""):
        out.append("改了 Caption 文本")
    bl, al = b["layout"], a["layout"]
    if (bl.get("width"), bl.get("height")) != (al.get("width"), al.get("height")):
        out.append(f"画布 {bl.get('width')}×{bl.get('height')} → {al.get('width')}×{al.get('height')}")
    bs, as_ = bl.get("summary") or {}, al.get("summary") or {}
    if (bs.get("caption") or "") != (as_.get("caption") or ""):
        out.append("改了整体描述")
    for k, zh in (("meta", "类型词"), ("canvas", "画布类型"), ("palette", "色板")):
        if bs.get(k) != as_.get(k):
            out.append(f"改了{zh}")
    bi = {it.get("id"): it for it in bl.get("items") or []}
    ai = {it.get("id"): it for it in al.get("items") or []}
    for iid, it in ai.items():
        if iid not in bi:
            out.append(f"新增框「{item_name(it)}」{it.get('bbox')}")
    for iid, it in bi.items():
        if iid not in ai:
            out.append(f"删除框「{item_name(it)}」")
    for iid, it in ai.items():
        o = bi.get(iid)
        if not o:
            continue
        ch = []
        if o.get("bbox") != it.get("bbox"):
            ch.append(f"位置 {o.get('bbox')}→{it.get('bbox')}")
        for k, zh in (("caption", "描述"), ("text", "文字"), ("name", "名称"), ("label", "类型"),
                      ("depth", "景深"), ("body", "体块"), ("hidden", "显隐"), ("locked", "锁定"), ("group", "成组"),
                      ("tags", "标签"), ("palette", "色板")):
            if (o.get(k) or None) != (it.get(k) or None):
                ch.append(zh)
        if ch:
            out.append(f"「{item_name(it)}」：{'，'.join(ch)}")
    bo = [x for x in (it.get("id") for it in bl.get("items") or []) if x in ai]
    ao = [x for x in (it.get("id") for it in al.get("items") or []) if x in bi]
    if bo != ao:
        out.append("调整了图层顺序")
    if (bl.get("camera") or {}) != (al.get("camera") or {}):
        c = al.get("camera") or {}
        out.append("调整了摄像机" + (f"（环绕{c.get('orbit')}° 俯仰{c.get('pitch')}° 视角{c.get('fov')}°）" if c.get("enabled") else "（关闭）"))
    if (bl.get("perspective") or {}) != (al.get("perspective") or {}):
        out.append("调整了透视辅助")
    lb = sanitize_lighting(bl.get("lighting")) or default_lighting()
    la = sanitize_lighting(al.get("lighting")) or default_lighting()
    if lb != la:
        pn = (PRESET_BY_ID.get(la["preset"]) or {}).get("name")
        out.append("调整了灯光" + ("（关闭）" if not la["enabled"] else f"（{pn or '自定义'}，{len(la['lights'])} 盏灯）"))
    return out
