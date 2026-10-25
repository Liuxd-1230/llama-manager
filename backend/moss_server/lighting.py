"""灯光：数据清洗、预设、提示词短语。与 src/lib/lighting.ts 逐字一致（tests/test_lighting.py 用共享样例校验）。

方向约定和机位一样：azimuth 像环绕角（0 = 从初始机位一侧照向主体，正 = 画面右侧，180 = 背后），elevation 像俯仰（正 = 从上往下照）。
"""

from __future__ import annotations

import json
import math
import random
import re
import string
import sys
from pathlib import Path
from typing import Any, Optional


def _data_path() -> Path:
    p = Path(__file__).with_name("lighting_data.json")
    if p.exists():
        return p
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent)) / "server" / "lighting_data.json"


DATA = json.loads(_data_path().read_text(encoding="utf-8"))
ROLES: dict[str, dict] = DATA["roles"]
ROLE_ORDER = ["key", "fill", "rim", "bg", "practical"]
PRESETS: list[dict] = DATA["presets"]
EXTRAS: list[dict] = DATA["extras"]
PRESET_BY_ID = {p["id"]: p for p in PRESETS}
PRESET_BY_NAME = {p["name"]: p for p in PRESETS}
EXTRA_BY_ID = {e["id"]: e for e in EXTRAS}
EXTRA_BY_LABEL = {e["label"]: e for e in EXTRAS}
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def _num(v: Any, d: float) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return d
    return float(v)


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _wrap(d: float) -> float:
    return ((d + 180.0) % 360.0 + 360.0) % 360.0 - 180.0


def _round(v: float, n: int) -> float:
    # 与 JS Math.round 一致（.5 向上）
    k = 10 ** n
    return math.floor(v * k + 0.5) / k


def _js_round(v: float) -> int:
    return int(math.floor(v + 0.5))


def new_light_id() -> str:
    return "l" + "".join(random.choices(string.ascii_lowercase + string.digits, k=6))


# ---------- 颜色 ----------
def kelvin_rgb(k: float) -> tuple[float, float, float]:
    t = _clamp(k, 1000, 40000) / 100
    r = 255 if t <= 66 else 329.698727446 * math.pow(t - 60, -0.1332047592)
    g = 99.4708025861 * math.log(t) - 161.1195681661 if t <= 66 else 288.1221695283 * math.pow(t - 60, -0.0755148492)
    b = 255 if t >= 66 else (0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307)
    return (_clamp(r, 0, 255) / 255, _clamp(g, 0, 255) / 255, _clamp(b, 0, 255) / 255)


def _hex_rgb(h: str) -> tuple[float, float, float]:
    m = h if _HEX.match(h or "") else "#ffffff"
    return (int(m[1:3], 16) / 255, int(m[3:5], 16) / 255, int(m[5:7], 16) / 255)


def kelvin_hex(k: float) -> str:
    return "#" + "".join(f"{_js_round(_clamp(v, 0, 1) * 255):02x}" for v in kelvin_rgb(k))


def _hue_word(hx: str, zh: bool) -> str:
    r, g, b = _hex_rgb(hx)
    mx, mn = max(r, g, b), min(r, g, b)
    lum = (mx + mn) / 2
    s = 0 if mx == mn else ((mx - mn) / (2 - mx - mn) if lum > 0.5 else (mx - mn) / (mx + mn))
    if s < 0.2:
        return ""
    if mx == r:
        h = math.fmod((g - b) / (mx - mn), 6)
    elif mx == g:
        h = (b - r) / (mx - mn) + 2
    else:
        h = (r - g) / (mx - mn) + 4
    h = (math.fmod(h * 60, 360) + 360) % 360
    bins = [(15, "红色", "red"), (40, "橙色", "orange"), (65, "黄色", "yellow"), (160, "绿色", "green"), (200, "青色", "cyan"),
            (250, "蓝色", "blue"), (290, "紫色", "purple"), (345, "品红色", "magenta"), (361, "红色", "red")]
    for lim, z, e in bins:
        if h < lim:
            return z if zh else e
    return ""


def _color_word(l: dict, zh: bool) -> str:
    k = l.get("kelvin")
    if k is None:
        return _hue_word(l.get("color") or "#ffffff", zh)
    if k < 2300:
        return "橙红色" if zh else "deep orange"
    if k < 3300:
        return "暖金色" if zh else "warm golden"
    if k < 4500:
        return "偏暖" if zh else "warm"
    if k < 6800:
        return ""
    if k < 8000:
        return "偏冷" if zh else "cool"
    return "冷蓝色" if zh else "cold blue"


# ---------- 清洗 ----------
def default_lighting() -> dict:
    return {"enabled": False, "preset": "", "lights": [], "ambient": 0.35, "ambient_kelvin": 6500, "extras": [],
            "note": "", "follow": False}


def sanitize_light(raw: Any, i: int = 0) -> dict:
    l = raw if isinstance(raw, dict) else {}
    role = l.get("role") if l.get("role") in ROLE_ORDER else ("key" if i == 0 else "fill")
    kv = l.get("kelvin", 5600 if "kelvin" not in l and not _HEX.match(str(l.get("color") or "")) else None)
    if "kelvin" not in l and _HEX.match(str(l.get("color") or "")):
        kv = None
    if kv is not None:
        kn = _num(kv, 5600)
        kelvin: Optional[int] = _js_round(_clamp(kn, 1000, 20000))
    else:
        kelvin = None
    color = kelvin_hex(kelvin) if kelvin is not None else (
        str(l["color"]).lower() if _HEX.match(str(l.get("color") or "")) else "#ffffff")
    lid = l.get("id") if isinstance(l.get("id"), str) and l.get("id") else new_light_id()
    return {
        "id": lid,
        "role": role,
        "enabled": l.get("enabled") is not False,
        "azimuth": _round(_wrap(_num(l.get("azimuth"), 0)), 1),
        "elevation": _round(_clamp(_num(l.get("elevation"), 30), -89, 89), 1),
        "intensity": _round(_clamp(_num(l.get("intensity"), 1), 0, 2), 2),
        "kelvin": kelvin,
        "color": color,
        "softness": _round(_clamp(_num(l.get("softness"), 0.5), 0, 1), 2),
    }


def sanitize_lighting(raw: Any) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    d = default_lighting()
    lights, used = [], set()
    for i, l in enumerate((raw.get("lights") if isinstance(raw.get("lights"), list) else [])[:8]):
        n = sanitize_light(l, i)
        while n["id"] in used:
            n["id"] = new_light_id()
        used.add(n["id"])
        lights.append(n)
    extras = []
    for x in raw.get("extras") if isinstance(raw.get("extras"), list) else []:
        e = EXTRA_BY_ID.get(x) or EXTRA_BY_LABEL.get(x) if isinstance(x, str) else None
        if e and e["id"] not in extras:
            extras.append(e["id"])
    preset = raw.get("preset")
    return {
        "enabled": bool(raw.get("enabled")),
        "preset": preset if isinstance(preset, str) and preset in PRESET_BY_ID else "",
        "lights": lights,
        "ambient": _round(_clamp(_num(raw.get("ambient"), d["ambient"]), 0, 1), 2),
        "ambient_kelvin": _js_round(_clamp(_num(raw.get("ambient_kelvin"), d["ambient_kelvin"]), 1000, 20000)),
        "extras": extras,
        "note": raw["note"][:400] if isinstance(raw.get("note"), str) else "",
        "follow": bool(raw.get("follow")),
    }


def _cam_orbit(cam: Optional[dict]) -> float:
    return _num((cam or {}).get("orbit"), 0) if cam and cam.get("enabled") else 0.0


def find_preset(ref: Any) -> Optional[dict]:
    if not isinstance(ref, str):
        return None
    r = ref.strip()
    return PRESET_BY_ID.get(r) or PRESET_BY_NAME.get(r) or next(
        (p for p in PRESETS if r and (r in p["name"] or p["name"] in r or r.lower() == p["en"].split(",")[0].lower())), None)


def preset_lighting(ref: Any, cam: Optional[dict], cur: Optional[dict] = None) -> Optional[dict]:
    p = find_preset(ref)
    if not p:
        return None
    base = sanitize_lighting(cur) or default_lighting()
    o = 0.0 if base["follow"] else _cam_orbit(cam)
    return sanitize_lighting({
        **base, "enabled": True, "preset": p["id"], "ambient": p["ambient"], "ambient_kelvin": p["ambient_kelvin"],
        "extras": list(p.get("extras") or []),
        "lights": [{"role": l["role"], "enabled": True, "azimuth": _wrap(l["azimuth"] + o), "elevation": l["elevation"],
                    "intensity": l["intensity"], "kelvin": l.get("kelvin"), "color": l.get("color") or "#ffffff",
                    "softness": l["softness"]} for l in p["lights"]],
    })


# ---------- 方向 ----------
def _norm(a: list[float]) -> list[float]:
    n = math.hypot(*a) or 1.0
    return [x / n for x in a]


def _cross(a: list[float], b: list[float]) -> list[float]:
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def _dot(a: list[float], b: list[float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cam_basis(cam: Optional[dict]) -> tuple[list[float], list[float], list[float]]:
    on = bool(cam) and bool(cam.get("enabled"))
    o = math.radians(_num(cam.get("orbit"), 0) if on else 0)
    p = math.radians(_clamp(_num(cam.get("pitch"), 0), -85, 85) if on else 0)
    rr = math.radians(_num(cam.get("roll"), 0) if on else 0)
    d = [math.sin(o) * math.cos(p), -math.sin(p), -math.cos(o) * math.cos(p)]
    fwd = [-d[0], -d[1], -d[2]]
    r0 = _norm(_cross(fwd, [0, -1, 0]))
    d0 = _cross(fwd, r0)
    right = [r0[i] * math.cos(rr) + d0[i] * math.sin(rr) for i in range(3)]
    down = [d0[i] * math.cos(rr) - r0[i] * math.sin(rr) for i in range(3)]
    return right, down, d


def light_vec(az: float, el: float) -> list[float]:
    a, e = math.radians(az), math.radians(el)
    return [math.sin(a) * math.cos(e), -math.sin(e), -math.cos(a) * math.cos(e)]


def rel_dir(l: dict, lg: dict, cam: Optional[dict]) -> tuple[float, float]:
    """(h, v)：h = 水平面里相对机位的方位，v = 灯的世界高度角。"""
    az = _wrap(l["azimuth"] + (_cam_orbit(cam) if lg.get("follow") else 0))
    return _wrap(az - _cam_orbit(cam)), l["elevation"]


def _direction_text(h: float, v: float, zh: bool) -> str:
    if v >= 65:
        return "正上方" if zh else "directly overhead"
    if v <= -65:
        return "正下方" if zh else "directly below"
    ah = abs(h)
    left = h < 0
    if ah <= 20:
        horiz = "正前方" if zh else "the front"
    elif ah <= 65:
        horiz = ("左前方" if left else "右前方") if zh else ("the front left" if left else "the front right")
    elif ah <= 115:
        horiz = ("左侧" if left else "右侧") if zh else ("the left side" if left else "the right side")
    elif ah <= 160:
        horiz = ("左后方" if left else "右后方") if zh else ("behind on the left" if left else "behind on the right")
    else:
        horiz = "正后方" if zh else "directly behind"
    d = int(math.floor(abs(v) / 5 + 0.5) * 5)
    if v >= 30:
        vert = f"高处（约 {d}°）" if zh else f"high above (about {d} degrees)"
    elif v >= 10:
        vert = "略高处" if zh else "slightly above"
    elif v > -10:
        vert = "平视高度" if zh else "at eye level"
    else:
        vert = f"低处（约 {d}°，由下往上）" if zh else f"from below (about {d} degrees)"
    return horiz + vert if zh else f"{horiz}, {vert}"


def preset_matches(lg: dict, cam: Optional[dict]) -> bool:
    p = PRESET_BY_ID.get(lg.get("preset") or "")
    if not p or not p["lights"]:
        return False
    pl = p["lights"][0]
    l = next((x for x in lg["lights"] if x["enabled"] and x["role"] == pl["role"]), None)
    if not l:
        return False
    h, v = rel_dir(l, lg, cam)
    return abs(abs(h) - abs(pl["azimuth"])) <= 30 and abs(v - pl["elevation"]) <= 25


def _active(lg: dict) -> list[dict]:
    return [l for l in lg["lights"] if l["enabled"] and l["intensity"] > 0.02]


def _light_clause(l: dict, lg: dict, cam: Optional[dict], key_i: float, zh: bool) -> str:
    h, v = rel_dir(l, lg, cam)
    dr = _direction_text(h, v, zh)
    ratio = l["intensity"] / key_i if key_i > 0 else 1
    strength = ""
    if l["role"] == "key":
        if l["intensity"] >= 1.25:
            strength = "强烈" if zh else "strong"
        elif l["intensity"] <= 0.5:
            strength = "微弱" if zh else "dim"
    elif ratio < 0.3:
        strength = "微弱" if zh else "faint"
    elif ratio >= 1.1:
        strength = "强烈" if zh else "strong"
    s = l["softness"]
    quality = ("硬朗" if zh else "hard") if s <= 0.25 else (("柔和漫射" if zh else "soft diffused") if s >= 0.7 else "")
    color = _color_word(l, zh)
    role = ROLES[l["role"]]
    if zh:
        adj = "、".join(x for x in (strength, quality) if x)
        light = (adj + "的" if adj else "") + color + "光"
        plain = light == "光"
        if l["role"] == "bg":
            return "背景光照亮主体身后的背景" if plain else f"背景光为{light}，照亮主体身后的背景"
        if l["role"] == "practical":
            return f"场景中有{'' if plain else light[:-1] + '的'}实景光源，从{dr}照来"
        if l["role"] == "rim":
            return f"轮廓光从{dr}勾勒边缘" if plain else f"轮廓光为{light}，从{dr}勾勒边缘"
        return f"{role['zh']}从{dr}照来" if plain else f"{role['zh']}为{light}，从{dr}照来"
    adj = " ".join(x for x in (strength, quality, color) if x)
    pre = adj + " " if adj else ""
    if l["role"] == "bg":
        return f"{pre}background light illuminating the backdrop behind the subject"
    if l["role"] == "practical":
        return f"{pre}practical light source visible in the scene, coming from {dr}"
    if l["role"] == "rim":
        return f"{pre}rim light from {dr}, outlining the edges"
    return f"{pre}{role['en']} from {dr}"


def _tone_clause(lg: dict, on: list[dict], zh: bool) -> str:
    amb = lg["ambient"]
    keys = [l for l in on if l["role"] == "key"]
    key_i = max((l["intensity"] for l in keys), default=0) if keys else max((l["intensity"] for l in on), default=0)
    fill = sum(l["intensity"] for l in on if l["role"] == "fill")
    if not on:
        if amb >= 0.6:
            out = "整体明亮通透，光线均匀" if zh else "bright, even ambient light"
        elif amb <= 0.1:
            out = "环境非常昏暗" if zh else "very dark surroundings"
        else:
            return ""
    else:
        ratio = (key_i + 0.001) / (fill + amb + 0.05)
        if amb >= 0.65 and ratio < 2.2:
            out = "整体明亮通透，反差低，阴影柔和" if zh else "bright, airy, low-contrast lighting with soft shadows"
        elif ratio >= 6 or amb <= 0.08:
            out = "环境昏暗，阴影浓重，明暗对比强烈" if zh else "dark surroundings, deep shadows and high contrast (chiaroscuro)"
        elif ratio >= 3:
            out = "中等反差，阴影清晰" if zh else "moderate contrast with defined shadows"
        else:
            out = "反差柔和，暗部通透" if zh else "gentle contrast with soft, open shadows"
    if amb >= 0.25:
        if lg["ambient_kelvin"] >= 8500:
            out += "，环境色调偏冷蓝" if zh else ", with a cool blue ambient tone"
        elif lg["ambient_kelvin"] <= 3800:
            out += "，环境色调偏暖" if zh else ", with a warm ambient tone"
    return out


_END = re.compile(r"[\s。.!！;；,，]+$")


def lighting_phrase(lg_in: Any, cam: Optional[dict], zh: bool) -> str:
    """灯光 → 提示词短语；灯光关闭或没有内容时返回空串。"""
    lg = sanitize_lighting(lg_in)
    if not lg or not lg["enabled"]:
        return ""
    on = _active(lg)
    parts: list[str] = []
    p = PRESET_BY_ID.get(lg["preset"])
    if p and preset_matches(lg, cam):
        parts.append(p["zh"] if zh else p["en"])
    keys = [l for l in on if l["role"] == "key"]
    key_i = max(l["intensity"] for l in keys) if keys else (max(l["intensity"] for l in on) if on else 0)
    ordered = sorted(on, key=lambda l: (ROLE_ORDER.index(l["role"]), -l["intensity"]))
    for l in ordered[:5]:
        parts.append(_light_clause(l, lg, cam, key_i, zh))
    sentences: list[str] = []
    if parts:
        sentences.append(("；" if zh else "; ").join(parts))
    tone = _tone_clause(lg, on, zh)
    if tone:
        sentences.append(tone)
    ex = [EXTRA_BY_ID[x]["zh" if zh else "en"] for x in lg["extras"] if x in EXTRA_BY_ID]
    if ex:
        sentences.append(("，" if zh else ", ").join(ex))
    note = _END.sub("", lg["note"].strip())
    if note:
        sentences.append(note)
    if not sentences:
        return ""
    if zh:
        return "光线：" + "。".join(sentences) + "。"
    return "Lighting: " + ". ".join(s[0].upper() + s[1:] for s in sentences) + "."


def describe_lighting(lg_in: Any, cam: Optional[dict]) -> Optional[dict]:
    """给 Agent 看的紧凑灯光状态。"""
    lg = sanitize_lighting(lg_in)
    if not lg or not lg["enabled"]:
        return None
    lights = []
    for l in lg["lights"]:
        h, v = rel_dir(l, lg, cam)
        # azimuth 给相对当前机位的值（和 set_lighting 的参数同一个参照）
        lights.append({"id": l["id"], "role": l["role"], "enabled": l["enabled"], "azimuth": _round(h, 1),
                       "elevation": l["elevation"], "intensity": l["intensity"], "kelvin": l["kelvin"],
                       "color": l["color"], "softness": l["softness"],
                       "in_frame": _direction_text(h, v, True)})
    return {"preset": lg["preset"], "preset_name": (PRESET_BY_ID.get(lg["preset"]) or {}).get("name", ""),
            "follow_camera": lg["follow"], "ambient": lg["ambient"], "ambient_kelvin": lg["ambient_kelvin"],
            "extras": lg["extras"], "note": lg["note"], "lights": lights}
