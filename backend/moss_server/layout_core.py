"""Layout / Caption 草稿：清洗、编辑器元数据、前后关系与镜头短语、编译。"""

from __future__ import annotations

import importlib.util
import math
import re
from typing import Any, Optional

from .config import SKILL_COMPILE
from .lighting import lighting_phrase, sanitize_lighting

_spec = importlib.util.spec_from_file_location("compile_prompt", SKILL_COMPILE)
_compile_mod = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_compile_mod)
compile_prompt = _compile_mod.compile_prompt

def _ensure_wh(w: int, h: int) -> tuple[int, int]:
    w = max(16, (w // 16) * 16)
    h = max(16, (h // 16) * 16)
    return w, h


def _as_int(v: Any, default: int = 0) -> int:
    try:
        if isinstance(v, bool):
            return default
        return int(round(float(v)))
    except (TypeError, ValueError):
        return default


def _sanitize_caption_draft(draft: dict) -> dict:
    cap = draft.get("caption")
    if not isinstance(cap, str) or not cap.strip():
        # layout-shaped mistaken as caption: try summary
        summary = draft.get("summary") if isinstance(draft.get("summary"), dict) else {}
        cap = summary.get("caption") if isinstance(summary.get("caption"), str) else ""
    if not isinstance(cap, str) or not cap.strip():
        cap = "An image."
    return {"caption": cap.strip()}


def _sanitize_layout_draft(draft: dict, width: int | None = None, height: int | None = None) -> dict:
    """Strip LLM extras and coerce types so official compile_prompt accepts the draft."""
    w = _as_int(width if width is not None else draft.get("width"), 1024)
    h = _as_int(height if height is not None else draft.get("height"), 1024)
    w, h = _ensure_wh(w, h)

    raw_summary = draft.get("summary") if isinstance(draft.get("summary"), dict) else {}
    caption = raw_summary.get("caption")
    if not isinstance(caption, str) or not caption.strip():
        caption = draft.get("caption") if isinstance(draft.get("caption"), str) else ""
    if not isinstance(caption, str) or not caption.strip():
        caption = "A composed image."

    summary: dict[str, Any] = {"caption": caption.strip()}
    canvas = raw_summary.get("canvas")
    if canvas in ("single", "multi_panel", "collage"):
        summary["canvas"] = canvas
    else:
        summary["canvas"] = "single"
    for key in ("meta", "palette"):
        val = raw_summary.get(key)
        if isinstance(val, list):
            cleaned = [str(x).strip() for x in val if isinstance(x, str) and str(x).strip()]
            if cleaned:
                summary[key] = cleaned

    items_in = draft.get("items") if isinstance(draft.get("items"), list) else []
    items: list[dict[str, Any]] = []
    for idx, it in enumerate(items_in):
        if not isinstance(it, dict):
            continue
        label = it.get("label")
        if label not in ("object", "character", "text"):
            label = "object"
        cap = it.get("caption")
        if not isinstance(cap, str) or not cap.strip():
            cap = f"Region {idx + 1}"
        bbox_raw = it.get("bbox")
        if not (isinstance(bbox_raw, list) and len(bbox_raw) == 4):
            # default box covering most of canvas
            bbox = [w // 8, h // 8, w * 7 // 8, h * 7 // 8]
        else:
            x1, y1, x2, y2 = (_as_int(v) for v in bbox_raw)
            # order
            if x2 < x1:
                x1, x2 = x2, x1
            if y2 < y1:
                y1, y2 = y2, y1
            # clamp
            x1 = max(0, min(x1, w - 2))
            y1 = max(0, min(y1, h - 2))
            x2 = max(x1 + 1, min(x2, w))
            y2 = max(y1 + 1, min(y2, h))
            if x2 <= x1 or y2 <= y1:
                x1, y1, x2, y2 = w // 8, h // 8, w * 7 // 8, h * 7 // 8
            bbox = [x1, y1, x2, y2]
        out_item: dict[str, Any] = {
            "label": label,
            "caption": cap.strip(),
            "bbox": bbox,
        }
        if label == "text":
            t = it.get("text")
            if not isinstance(t, str) or not t.strip():
                t = cap.strip()
            out_item["text"] = t.strip()
        elif isinstance(it.get("text"), str) and it["text"].strip():
            out_item["text"] = it["text"].strip()
        for key in ("tags", "palette"):
            val = it.get(key)
            if isinstance(val, list):
                cleaned = [str(x).strip() for x in val if isinstance(x, str) and str(x).strip()]
                if cleaned:
                    out_item[key] = cleaned
        out_item.update(_sanitize_item_meta(it))
        items.append(out_item)

    if not items:
        items = [
            {
                "label": "object",
                "caption": caption.strip(),
                "bbox": [w // 8, h // 8, w * 7 // 8, h * 7 // 8],
            }
        ]

    out: dict[str, Any] = {
        "width": w,
        "height": h,
        "bbox_coord_space": "abs",
        "bbox_format": "xyxy",
        "summary": summary,
        "items": items,
    }
    persp = _sanitize_perspective(draft.get("perspective"))
    if persp is not None:
        out["perspective"] = persp
    opts = draft.get("prompt_options")
    if isinstance(opts, dict):
        out["prompt_options"] = {
            "depth": opts.get("depth") is not False,
            "perspective": bool(opts.get("perspective")),
            "camera": opts.get("camera") is not False,
            "lighting": opts.get("lighting") is not False,
        }
    cam = sanitize_camera(draft.get("camera"))
    if cam is not None:
        out["camera"] = cam
    lg = sanitize_lighting(draft.get("lighting"))
    if lg is not None:
        out["lighting"] = lg
    return out


# ---------- 编辑器元数据（图层 / 景深 / 透视）----------
# 这些字段只给编辑器用：草稿与历史里保留，编译前剥离，不进入官方 schema。
EDITOR_ITEM_KEYS = ("id", "name", "hidden", "locked", "depth", "color", "body", "group", "shape", "points")
EDITOR_ROOT_KEYS = ("perspective", "prompt_options", "camera", "lighting")
DEPTH_TIERS = ("auto", "fg", "mg", "bg")


def _sanitize_item_meta(it: dict) -> dict:
    meta: dict[str, Any] = {}
    if isinstance(it.get("id"), str) and it["id"].strip():
        meta["id"] = it["id"].strip()[:64]
    if isinstance(it.get("name"), str) and it["name"].strip():
        meta["name"] = it["name"].strip()[:80]
    if isinstance(it.get("group"), str) and it["group"].strip():
        meta["group"] = it["group"].strip()[:40]
    for key in ("hidden", "locked"):
        if isinstance(it.get(key), bool):
            meta[key] = it[key]
    if it.get("depth") in DEPTH_TIERS:
        meta["depth"] = it["depth"]
    if isinstance(it.get("color"), int) and not isinstance(it.get("color"), bool):
        meta["color"] = it["color"] % 6
    body = sanitize_body(it.get("body"))
    if body is not None:
        meta["body"] = body
    return meta


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if f == f and abs(f) < 1e7 else None


def _sanitize_perspective(p: Any) -> Optional[dict]:
    if not isinstance(p, dict):
        return None
    out: dict[str, Any] = {
        "enabled": bool(p.get("enabled")),
        "mode": p.get("mode") if p.get("mode") in (1, 2, 3) else 1,
        "show_grid": bool(p.get("show_grid")),
        "auto_scale": bool(p.get("auto_scale")),
        "source": p.get("source") if p.get("source") in ("manual", "boxes", "image") else "manual",
    }
    for key in ("horizon_y", "vp1_x", "vp2_x", "vp3_x", "vp3_y"):
        n = _num(p.get(key))
        if n is not None:
            out[key] = round(n, 2)
    if "horizon_y" not in out or "vp1_x" not in out:
        return None
    return out


_CJK = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")


def _is_cjk(text: str) -> bool:
    return bool(_CJK.search(text or ""))


def _short_ref(it: dict, zh: bool) -> str:
    """生成「在 X 前面」里的 X。优先图层名，其次框内描述的第一小句。"""
    name = (it.get("name") or "").strip()
    if not name and it.get("label") == "text" and (it.get("text") or "").strip():
        t = it["text"].strip().splitlines()[0][:24]
        return f"文字「{t}」" if zh else f'the text "{t}"'
    src = name or (it.get("caption") or "").strip()
    src = re.split(r"[，。,.;；:：!?！？\n]", src, maxsplit=1)[0].strip() or src.strip()
    if zh or _is_cjk(src):
        return f"「{src[:16]}」"
    words = src.split()
    if words and words[0].lower() in ("a", "an", "the"):
        words = words[1:]
    ref = " ".join(words[:6]) or "object"
    if not name:
        ref = ref[0].lower() + ref[1:] if len(ref) > 1 and not ref[:2].isupper() else ref
        return f"the {ref}"
    # 小写开头的名字当普通名词（the girl），大写开头当专有名词（Alice）
    return f"the {ref}" if ref[:1].islower() else ref


def _area(b: list) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def _inter(a: list, b: list) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


TIER_EN = {"fg": "in the foreground", "mg": "in the middle ground", "bg": "in the background"}
TIER_ZH = {"fg": "位于前景", "mg": "位于中景", "bg": "位于背景"}


def depth_phrases(items: list[dict]) -> list[str]:
    """
    根据图层顺序（数组越靠后越靠前）+ 框重叠，为每个框生成前后关系短语。
    文字框不参与遮挡关系（通常是叠加在画面上的字）。返回与 items 等长的列表，空串表示无。
    """
    out: list[str] = []
    n = len(items)
    for i, it in enumerate(items):
        zh = _is_cjk(it.get("caption", ""))
        parts: list[str] = []
        tier_txt = ""
        tier = it.get("depth")
        if tier in TIER_EN:
            tier_txt = TIER_ZH[tier] if zh else TIER_EN[tier]
        if it.get("label") != "text":
            a = it["bbox"]
            fronts: list[tuple[float, str]] = []
            behinds: list[tuple[float, str]] = []
            for j in range(n):
                if j == i or items[j].get("label") == "text":
                    continue
                b = items[j]["bbox"]
                inter = _inter(a, b)
                if inter <= 0:
                    continue
                small = min(_area(a), _area(b)) or 1.0
                if inter / small < 0.05:
                    continue
                ref = _short_ref(items[j], zh)
                if j < i:  # j 在 i 后面 → i 在 j 前面
                    covers_all = inter / (_area(b) or 1.0) >= 0.95
                    if zh:
                        txt = f"在{ref}前方" + ("" if covers_all else "，部分遮挡它")
                    else:
                        txt = f"in front of {ref}" + ("" if covers_all else ", partially occluding it")
                    fronts.append((inter, txt))
                else:  # j 在 i 前面
                    inside = inter / (_area(a) or 1.0) >= 0.95
                    if zh:
                        txt = f"在{ref}后方" + ("" if inside else "，被它部分遮挡")
                    else:
                        txt = f"behind {ref}" + ("" if inside else ", partly hidden by it")
                    behinds.append((inter, txt))
            fronts.sort(key=lambda x: -x[0])
            behinds.sort(key=lambda x: -x[0])
            parts += [t for _, t in fronts[:2]] + [t for _, t in behinds[:2]]
        if not parts and not tier_txt:
            out.append("")
            continue
        sep = "；" if zh else "; "
        body = sep.join(parts)
        if tier_txt:
            body = tier_txt + (("，" if zh else ", ") + body if body else "")
        if zh:
            out.append(body + "。")
        else:
            out.append(body[0].upper() + body[1:] + ".")
    return out


def perspective_phrase(p: dict, width: int, height: int, zh: bool) -> str:
    y0 = p.get("horizon_y", height / 2)
    r = y0 / height if height else 0.5
    mode = p.get("mode", 1)
    if zh:
        if r < 0:
            view = "高角度鸟瞰俯视，地平线在画面上方之外"
        elif r < 0.2:
            view = "高角度俯视，地平线很高、靠近画面顶部"
        elif r < 0.4:
            view = "略微俯视，地平线位于画面上三分之一"
        elif r <= 0.6:
            view = "平视机位，地平线位于画面中部"
        elif r <= 0.8:
            view = "略微仰视，地平线位于画面下三分之一"
        elif r <= 1:
            view = "低机位仰视，地平线靠近画面底部"
        else:
            view = "极低机位虫视仰拍，地平线在画面下方之外"
    else:
        if r < 0:
            view = "high-angle bird's-eye view looking down, horizon above the frame"
        elif r < 0.2:
            view = "high-angle view looking down, high horizon near the top of the frame"
        elif r < 0.4:
            view = "slightly high-angle view, horizon in the upper third"
        elif r <= 0.6:
            view = "eye-level view, horizon near the middle of the frame"
        elif r <= 0.8:
            view = "slightly low-angle view, horizon in the lower third"
        elif r <= 1:
            view = "low-angle view looking up, low horizon near the bottom of the frame"
        else:
            view = "worm's-eye view looking up, horizon below the frame"

    def xpos(x: float) -> str:
        q = x / width if width else 0.5
        if zh:
            if q < 0:
                return "画面左侧之外"
            if q < 0.4:
                return "偏左"
            if q <= 0.6:
                return "画面中央"
            if q <= 1:
                return "偏右"
            return "画面右侧之外"
        if q < 0:
            return "off-frame to the left"
        if q < 0.4:
            return "left of center"
        if q <= 0.6:
            return "at the center"
        if q <= 1:
            return "right of center"
        return "off-frame to the right"

    vp1 = p.get("vp1_x", width / 2)
    vp2 = p.get("vp2_x", width * 1.4)
    if mode == 1:
        persp = (f"一点透视，消失点在地平线{xpos(vp1)}" if zh
                 else f"one-point perspective with the vanishing point {xpos(vp1)} on the horizon")
    else:
        a, b = sorted([vp1, vp2])
        persp = (f"两点透视，两个消失点分别在{xpos(a)}和{xpos(b)}" if zh
                 else f"two-point perspective with vanishing points {xpos(a)} and {xpos(b)}")
        if mode == 3:
            up = p.get("vp3_y", height * 2.5) < y0
            if zh:
                persp = "三点透视，" + persp[5:] + ("，竖直线向上汇聚" if up else "，竖直线向下汇聚")
            else:
                persp = "three-point perspective, " + persp[len("two-point perspective "):] + (
                    ", vertical lines converging upward" if up else ", vertical lines converging downward")
    if zh:
        return f"机位与透视：{view}；{persp}。"
    return f"Camera and perspective: {view}; {persp}."


def _append_sentence(base: str, extra: str) -> str:
    base = base.rstrip()
    if not extra:
        return base
    zh = _is_cjk(base)
    if base and base[-1] not in ".。!！?？;；":
        base += "。" if zh else "."
    if not base:
        return extra
    return f"{base}{extra}" if zh and base[-1] in "。！？；" else f"{base} {extra}"


# ---------- 3D 体块与摄像机 ----------
BODY_ANCHORS = ("world", "screen", "backdrop")
CAMERA_KEYS = ("orbit", "pitch", "roll", "distance", "fov", "pan_x", "pan_y", "pan_z")
CAMERA_DEFAULT = {
    "enabled": False, "orbit": 0.0, "pitch": 0.0, "roll": 0.0,
    "distance": 1.0, "fov": 50.0, "pan_x": 0.0, "pan_y": 0.0, "pan_z": 0.0,
}
CAMERA_LIMITS = {
    "orbit": (-180.0, 180.0), "pitch": (-85.0, 85.0), "roll": (-60.0, 60.0),
    "distance": (0.2, 5.0), "fov": (10.0, 120.0),
    "pan_x": (-3.0, 3.0), "pan_y": (-3.0, 3.0), "pan_z": (-0.9, 3.0),
}


def _clampf(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def sanitize_body(b: Any) -> Optional[dict]:
    if not isinstance(b, dict):
        return None
    z = _num(b.get("z"))
    t = _num(b.get("thickness"))
    yaw = _num(b.get("yaw"))
    anchor = b.get("anchor") if b.get("anchor") in BODY_ANCHORS else "world"
    exact = b.get("exact") is True and anchor == "world"
    nd = 5 if exact else 0  # 精确体块（按真实尺寸建的）多留几位，避免来回保存时尺寸漂移
    return {
        "z": round(_clampf(z if z is not None else 1.0, 0.15, 12.0), max(4, nd)),
        "thickness": round(_clampf(t if t is not None else 0.3, 0.0, 3.0), max(3, nd)),
        "yaw": round(_clampf(yaw if yaw is not None else 0.0, -180.0, 180.0), 2),
        "anchor": anchor,
        **({"exact": True} if exact else {}),
    }


def sanitize_camera(c: Any) -> Optional[dict]:
    if not isinstance(c, dict):
        return None
    out = dict(CAMERA_DEFAULT)
    out["enabled"] = bool(c.get("enabled"))
    for k in CAMERA_KEYS:
        n = _num(c.get(k))
        if n is not None:
            lo, hi = CAMERA_LIMITS[k]
            # 4 位小数：平移 / 距离按主体深度放大，3 位在近景里会差出一两个像素
            out[k] = round(_clampf(n, lo, hi), 4)
    return out


def camera_is_base(c: Optional[dict]) -> bool:
    if not c:
        return True
    return all(abs(float(c.get(k, CAMERA_DEFAULT[k])) - float(CAMERA_DEFAULT[k])) < 1e-3 for k in CAMERA_KEYS)


def camera_active(d: dict) -> bool:
    c = d.get("camera")
    return isinstance(c, dict) and bool(c.get("enabled"))


def _subject(items: list[dict]) -> Optional[dict]:
    def area(it: dict) -> float:
        return _area(it["bbox"])
    chars = [it for it in items if it.get("label") == "character"]
    pool = chars or [it for it in items if it.get("label") != "text"]
    pool = [it for it in pool if (it.get("body") or {}).get("anchor", "world") == "world"] or pool
    return max(pool, key=area) if pool else None


def camera_phrase(cam: dict, items: list[dict], width: int, height: int, zh: bool) -> str:
    """把摄像机参数翻译成镜头语言；参数都在中性范围时返回空串。"""
    pitch = float(cam.get("pitch", 0))
    orbit = float(cam.get("orbit", 0))
    roll = float(cam.get("roll", 0))
    fov = float(cam.get("fov", 50))
    dist = float(cam.get("distance", 1))
    subj = _subject(items)
    rel = orbit - float(((subj or {}).get("body") or {}).get("yaw", 0.0))
    rel = (rel + 180.0) % 360.0 - 180.0
    parts: list[str] = []

    a = abs(pitch)
    if pitch >= 60:
        parts.append("俯瞰鸟瞰视角，几乎垂直向下拍摄" if zh else "bird's-eye view shot from almost directly above")
    elif pitch >= 25:
        parts.append(f"高机位俯拍，约 {round(a)}° 向下" if zh else f"high-angle shot looking down at about {round(a)} degrees")
    elif pitch >= 8:
        parts.append("略微俯拍" if zh else "slightly high-angle shot")
    elif pitch <= -60:
        parts.append("极低机位虫视仰拍" if zh else "worm's-eye view looking steeply up")
    elif pitch <= -25:
        parts.append(f"低机位仰拍，约 {round(a)}° 向上" if zh else f"low-angle shot looking up at about {round(a)} degrees")
    elif pitch <= -8:
        parts.append("略微仰拍" if zh else "slightly low-angle shot")

    r = abs(rel)
    side_zh = "右" if rel > 0 else "左"
    side_en = "right" if rel > 0 else "left"
    if 15 <= r < 60:
        parts.append(f"机位在{side_zh}前方的四分之三侧面视角" if zh else f"three-quarter view from the front {side_en}")
    elif 60 <= r < 120:
        parts.append(f"机位在{side_zh}侧的侧面视角" if zh else f"side profile view from the {side_en}")
    elif r >= 120:
        parts.append("从主体背后拍摄的背面视角" if zh else "view from behind the subject")

    if abs(roll) >= 5:
        parts.append(f"荷兰角倾斜约 {round(abs(roll))}°" if zh else f"dutch angle tilted about {round(abs(roll))} degrees")

    zoom = dist * math.tan(math.radians(fov) / 2) / math.tan(math.radians(25))
    if zoom < 0.45:
        parts.append("极近特写" if zh else "extreme close-up framing")
    elif zoom < 0.7:
        parts.append("近景特写" if zh else "close-up framing")
    elif zoom < 0.88:
        parts.append("镜头推近，构图更紧" if zh else "tighter, closer framing")
    elif 1.18 < zoom <= 1.7:
        parts.append("镜头拉远，构图更开阔" if zh else "wider framing with more surroundings")
    elif zoom > 1.7:
        parts.append("远景大全景" if zh else "wide establishing shot")

    if fov >= 85:
        parts.append("超广角镜头，透视畸变明显" if zh else "ultra-wide-angle lens with strong perspective distortion")
    elif fov >= 62:
        parts.append("广角镜头，近大远小明显" if zh else "wide-angle lens with pronounced perspective")
    elif fov <= 24:
        parts.append("长焦镜头，空间压缩感强" if zh else "telephoto lens with compressed depth")
    elif fov <= 36:
        parts.append("中长焦镜头，略带空间压缩" if zh else "short telephoto lens with slightly compressed depth")

    if not parts:
        return ""
    if zh:
        return "镜头：" + "，".join(parts) + "。"
    body = ", ".join(parts)
    return "Camera: " + body[0].upper() + body[1:] + "."


def apply_view(draft: dict, view: Any) -> dict:
    """
    摄像机视图（前端按机位投影算出）：替换各框 bbox、去掉出画的框、按新机位的远近重排图层。
    view = {"items": {id: {"bbox": [...], "visible": bool}}, "order": [id 从后到前]}
    """
    if not isinstance(view, dict) or not isinstance(view.get("items"), dict):
        return draft
    w, h = draft["width"], draft["height"]
    vitems = view["items"]
    by_id = {it.get("id"): it for it in draft.get("items", []) if it.get("id")}
    order = [i for i in (view.get("order") or []) if i in by_id]
    rest = [it for it in draft.get("items", []) if it.get("id") not in set(order)]
    seq = [by_id[i] for i in order] + rest
    out_items = []
    for it in seq:
        v = vitems.get(it.get("id"))
        if isinstance(v, dict):
            if v.get("visible") is False:
                continue
            b = v.get("bbox")
            if isinstance(b, list) and len(b) == 4:
                x1, y1, x2, y2 = (_as_int(x) for x in b)
                x1, x2 = max(0, min(x1, w - 1)), max(0, min(x2, w))
                y1, y2 = max(0, min(y1, h - 1)), max(0, min(y2, h))
                if x2 - x1 < 2 or y2 - y1 < 2:
                    continue
                it = {**it, "bbox": [x1, y1, x2, y2]}
        out_items.append(it)
    return {**draft, "items": out_items}


def fit_to_canvas(draft: dict) -> dict:
    """
    编译前把框裁到画布内、去掉完全在画布外的框。
    3D 体块（尤其按真实尺寸摆的、或转过机位后）存的 bbox 是"初始机位下的前脸"，超出画布是正常的；
    画面里只出现画布内那部分，所以这里裁掉，而不是报错。
    """
    w, h = draft.get("width"), draft.get("height")
    if not (isinstance(w, int) and isinstance(h, int)):
        return draft
    out, changed = [], False
    for it in draft.get("items", []):
        b = it.get("bbox")
        if not (isinstance(b, list) and len(b) == 4 and all(isinstance(x, (int, float)) for x in b)):
            out.append(it)
            continue
        x1, y1, x2, y2 = b
        if x2 < x1:
            x1, x2 = x2, x1
        if y2 < y1:
            y1, y2 = y2, y1
        nx1, ny1 = max(0, min(x1, w)), max(0, min(y1, h))
        nx2, ny2 = max(0, min(x2, w)), max(0, min(y2, h))
        if nx2 - nx1 < 2 or ny2 - ny1 < 2:
            changed = True
            continue
        nb = [int(round(nx1)), int(round(ny1)), int(round(nx2)), int(round(ny2))]
        if nb != b:
            changed = True
            it = {**it, "bbox": nb}
        out.append(it)
    return {**draft, "items": out} if changed else draft


def prepare_layout_for_compile(draft: dict, view: Any = None) -> dict:
    """
    把带编辑器元数据的 Layout 草稿转成官方 schema：
    - 摄像机开启且有视图：用投影后的框（出画的不编译），图层按新机位重排
    - 隐藏的框不参与编译
    - prompt_options.depth（默认开）→ 前后关系短语追加到各框 caption
    - prompt_options.camera（默认开）→ 镜头语言追加到 summary.caption
    - prompt_options.perspective（默认关）→ 透视短语（摄像机开启时由镜头语言代替）
    - prompt_options.lighting（默认开）+ lighting.enabled → 灯光描述追加到 summary.caption
    - 剥离 id/name/hidden/locked/depth/color/body/group、perspective、prompt_options、camera、lighting
    """
    opts = draft.get("prompt_options") if isinstance(draft.get("prompt_options"), dict) else {}
    use_depth = opts.get("depth") is not False
    use_persp = bool(opts.get("perspective"))
    use_cam = opts.get("camera") is not False
    use_light = opts.get("lighting") is not False
    cam_on = camera_active(draft)
    if cam_on and view is not None:
        draft = apply_view(draft, view)
    draft = fit_to_canvas(draft)
    visible = [it for it in draft.get("items", []) if not it.get("hidden")]
    if not visible:
        raise ValueError("没有可编译的框（全部隐藏或已出画）")
    phrases = depth_phrases(visible) if use_depth else [""] * len(visible)
    items = []
    for it, ph in zip(visible, phrases):
        clean = {k: v for k, v in it.items() if k not in EDITOR_ITEM_KEYS}
        if it.get('shape') in ('ellipse','polygon'):
            clean['caption'] = _append_sentence(clean.get('caption',''), it['shape'] + ' shaped region')
        if ph:
            clean["caption"] = _append_sentence(clean["caption"], ph)
        items.append(clean)
    summary = dict(draft["summary"])
    zh = _is_cjk(summary.get("caption", ""))
    if cam_on and use_cam:
        summary["caption"] = _append_sentence(
            summary["caption"], camera_phrase(draft["camera"], visible, draft["width"], draft["height"], zh)
        )
    elif use_persp and isinstance(draft.get("perspective"), dict):
        summary["caption"] = _append_sentence(
            summary["caption"], perspective_phrase(draft["perspective"], draft["width"], draft["height"], zh)
        )
    if use_light and isinstance(draft.get("lighting"), dict):
        summary["caption"] = _append_sentence(
            summary["caption"], lighting_phrase(draft["lighting"], draft.get("camera") if cam_on else None, zh)
        )
    return {k: v for k, v in draft.items() if k not in EDITOR_ROOT_KEYS} | {
        "summary": summary,
        "items": items,
    }


LAYER_RULES_HINT = (
    "图层约定：items 数组顺序就是图层顺序，越靠后越靠前（离镜头越近、会遮挡前面的元素）。"
    "远景/背景元素放在数组前面，前景主体放在后面。"
)


def sanitize_draft(draft: Any, *, mode: str | None = None, width: int | None = None, height: int | None = None) -> dict:
    if not isinstance(draft, dict):
        if mode == "layout":
            return _sanitize_layout_draft({}, width, height)
        return {"caption": "An image."}
    looks_layout = "items" in draft or mode == "layout"
    looks_caption = mode == "caption" or (
        "caption" in draft and "items" not in draft and "summary" not in draft
    )
    if looks_layout and not (mode == "caption" and looks_caption):
        return _sanitize_layout_draft(draft, width, height)
    return _sanitize_caption_draft(draft)


def compile_safe(draft: dict, view: Any = None) -> tuple[str | None, str | None]:
    """返回 (prompt, error)。"""
    try:
        if "items" in draft:
            draft = prepare_layout_for_compile(draft, view)
        return compile_prompt(draft), None
    except (ValueError, TypeError, OverflowError) as e:
        return None, str(e)


def compile_checks(draft: dict, view: Any = None) -> list[str]:
    """给 Agent 自检用：列出会导致编译失败或明显不对的问题（不改草稿）。"""
    probs: list[str] = []
    if "items" not in draft:
        if not str(draft.get("caption") or "").strip():
            probs.append("Caption 为空")
        return probs
    w, h = draft.get("width"), draft.get("height")
    if not (isinstance(w, int) and isinstance(h, int) and w % 16 == 0 and h % 16 == 0):
        probs.append("画布宽高必须是 16 的倍数")
    if not str((draft.get("summary") or {}).get("caption") or "").strip():
        probs.append("summary.caption（整体描述）为空")
    items = draft.get("items") or []
    if not items:
        probs.append("没有任何框")
    for i, it in enumerate(items):
        nm = it.get("name") or it.get("id") or f"#{i + 1}"
        cap = str(it.get("caption") or "").strip()
        if not cap or re.fullmatch(r"(区域|region)\s*\d+", cap, re.I):
            probs.append(f"框「{nm}」缺少描述（caption）")
        if it.get("label") == "text" and not str(it.get("text") or "").strip():
            probs.append(f"文字框「{nm}」缺少可见文字（text）")
        b = it.get("bbox") or []
        if len(b) == 4 and (b[2] - b[0] < 8 or b[3] - b[1] < 8):
            probs.append(f"框「{nm}」太小（小于 8px）")
    _, err = compile_safe(draft, view)
    if err:
        probs.append(f"编译报错：{err}")
    return probs
