"""图像反推：让视觉模型按「原图归一化坐标」给出每个元素的定位框，再换算到画布。

模型直接给画布像素坐标很不准（它看到的是缩放后的图，还要自己换算画布尺寸）。
这里统一要求 0–1000 归一化坐标：Gemini 系列用它训练时的 box_2d [ymin,xmin,ymax,xmax]，
其他模型用 box_1000 [x_min,y_min,x_max,y_max]。解析时兼容 bbox / box / 0–1 / 像素坐标。
"""

from __future__ import annotations

from typing import Any, Optional

ITEM_LABELS = ("object", "character", "text")


def box_format_for(model: str) -> str:
    m = (model or "").lower()
    return "box_2d" if "gemini" in m or "gemma" in m else "box_1000"


def reverse_rules(fmt: str, img_w: Optional[int], img_h: Optional[int], detail_text: str) -> str:
    if fmt == "box_2d":
        coord = ('"box_2d": [ymin, xmin, ymax, xmax]，四个整数，按原图归一化到 0–1000'
                 '（左上角 0,0，右下角 1000,1000；先 y 后 x）')
        example = '"box_2d":[120,300,950,640]'
    else:
        coord = ('"box_1000": [x_min, y_min, x_max, y_max]，四个整数，按原图归一化到 0–1000'
                 '（左上角 0,0，右下角 1000,1000）')
        example = '"box_1000":[300,120,640,950]'
    size = f"（原图 {img_w}×{img_h} 像素）" if img_w and img_h else ""
    return f"""
===== 本次任务：看图反推 + 定位框 =====
以下规则针对这张参考图{size}，**优先级高于上文关于字段和 bbox 的规定**；上文其余的写作要求（语言、描述口吻、禁止事项）照常遵守。

定位框（最重要）：
- 每个 item 用 {coord}。
- 框要紧贴该元素在图中**真实可见**的范围：人物包含头发、四肢、手持物和衣摆；不要把阴影、背景算进去。
- 不要输出画布像素坐标的 bbox，坐标换算由程序完成。

框哪些东西：
- 只框图里真实看得见的东西，不要编造。每个主要人物单独一个框（label:"character"）；重要物体 / 动物 / 载具 / 建筑用 "object"；
  看得清的文字（标题、招牌、logo 字样）用 "text"，原文写进 text 字段。
- 天空、远景、墙面等大面积背景如果对画面重要，可以给一个覆盖它的 object 框。
- 一般 3–12 个框，按从远到近（背景在前、前景在后）排列。
- 每个 item 加 "name"：2–6 个字的中文短名（如 "女孩"、"黑猫"、"招牌"），只用于界面显示。

{detail_text}

只输出一个 JSON 对象，不要 Markdown：
{{"summary":{{"caption":"...","canvas":"single","meta":["..."],"palette":["..."]}},
 "items":[{{"label":"character","name":"女孩","caption":"...",{example}}}]}}
""".strip()


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None


def _four(v: Any) -> Optional[list[float]]:
    if isinstance(v, (list, tuple)) and len(v) == 4:
        out = [_num(x) for x in v]
        return None if any(x is None for x in out) else out  # type: ignore[return-value]
    if isinstance(v, dict):
        keys = [("x1", "y1", "x2", "y2"), ("xmin", "ymin", "xmax", "ymax"), ("x_min", "y_min", "x_max", "y_max"),
                ("left", "top", "right", "bottom")]
        for ks in keys:
            if all(k in v for k in ks):
                out = [_num(v[k]) for k in ks]
                if all(x is not None for x in out):
                    return out  # type: ignore[return-value]
        if all(k in v for k in ("x", "y", "w", "h")) or all(k in v for k in ("x", "y", "width", "height")):
            x, y = _num(v.get("x")), _num(v.get("y"))
            w, h = _num(v.get("w", v.get("width"))), _num(v.get("h", v.get("height")))
            if None not in (x, y, w, h):
                return [x, y, x + w, y + h]  # type: ignore[operator]
    return None


def parse_box(item: dict, img_w: Optional[int], img_h: Optional[int]) -> Optional[list[float]]:
    """返回原图归一化 [x1, y1, x2, y2]（0–1），无法解析时返回 None。"""
    yx = False
    vals: Optional[list[float]] = None
    scale: Optional[str] = None
    for key, order, sc in (("box_2d", "yx", "1000"), ("box_1000", "xy", "1000"), ("bbox_1000", "xy", "1000"),
                           ("box_norm", "xy", None), ("box", "xy", None), ("bbox", "xy", None),
                           ("bbox_2d", "xy", None)):
        if key in item:
            vals = _four(item[key])
            if vals is not None:
                yx = order == "yx"
                scale = sc
                break
    if vals is None:
        return None
    if yx:
        vals = [vals[1], vals[0], vals[3], vals[2]]
    x1, y1, x2, y2 = vals
    mx = max(abs(v) for v in vals)
    if mx <= 1.0 + 1e-6:
        sx = sy = 1.0
    elif scale == "1000" or mx <= 1000.0 + 1e-6:
        # 约定的 0–1000；若超出 1000 说明是像素坐标
        sx = sy = 1000.0
        if mx > 1000.0 + 1e-6:
            sx, sy = float(img_w or mx), float(img_h or mx)
    else:
        sx, sy = float(img_w or mx), float(img_h or mx)
    x1, x2 = x1 / sx, x2 / sx
    y1, y2 = y1 / sy, y2 / sy
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    x1, y1 = max(0.0, min(1.0, x1)), max(0.0, min(1.0, y1))
    x2, y2 = max(0.0, min(1.0, x2)), max(0.0, min(1.0, y2))
    if x2 - x1 < 0.004 or y2 - y1 < 0.004:
        return None
    return [round(x1, 5), round(y1, 5), round(x2, 5), round(y2, 5)]


def _clean_list(v: Any) -> list[str]:
    if not isinstance(v, list):
        return []
    return [str(x).strip() for x in v if isinstance(x, str) and str(x).strip()]


def normalize_reverse(result: Any, img_w: Optional[int], img_h: Optional[int]) -> dict:
    """模型输出 → {summary, items:[{label,name,caption,text?,box}], dropped}"""
    if not isinstance(result, dict):
        result = {}
    raw_sum = result.get("summary") if isinstance(result.get("summary"), dict) else {}
    caption = raw_sum.get("caption") if isinstance(raw_sum.get("caption"), str) else ""
    if not caption.strip() and isinstance(result.get("caption"), str):
        caption = result["caption"]
    summary: dict[str, Any] = {"caption": caption.strip() or "A composed image."}
    summary["canvas"] = raw_sum.get("canvas") if raw_sum.get("canvas") in ("single", "multi_panel", "collage") else "single"
    for k in ("meta", "palette"):
        c = _clean_list(raw_sum.get(k))
        if c:
            summary[k] = c
    items_in = result.get("items")
    if not isinstance(items_in, list):
        items_in = result.get("objects") if isinstance(result.get("objects"), list) else []
    items: list[dict[str, Any]] = []
    dropped = 0
    for i, it in enumerate(items_in):
        if not isinstance(it, dict):
            continue
        box = parse_box(it, img_w, img_h)
        if box is None:
            dropped += 1
            continue
        label = it.get("label") if it.get("label") in ITEM_LABELS else "object"
        cap = it.get("caption") if isinstance(it.get("caption"), str) else ""
        name = it.get("name") if isinstance(it.get("name"), str) else ""
        out: dict[str, Any] = {"label": label, "caption": cap.strip() or f"Region {i + 1}", "name": name.strip()[:24],
                               "box": box}
        text = it.get("text") if isinstance(it.get("text"), str) else ""
        if label == "text":
            out["text"] = text.strip() or out["caption"]
        elif text.strip():
            out["text"] = text.strip()
        for k in ("tags", "palette"):
            c = _clean_list(it.get(k))
            if c:
                out[k] = c
        items.append(out)
    return {"summary": summary, "items": items, "dropped": dropped}


def items_to_draft(norm: dict, width: int, height: int) -> dict:
    """按「拉伸」把归一化框映射到 width×height 画布（前端会按裁切 / 留边重新映射）。"""
    items = []
    for it in norm.get("items", []):
        x1, y1, x2, y2 = it["box"]
        b = [int(round(x1 * width)), int(round(y1 * height)), int(round(x2 * width)), int(round(y2 * height))]
        b[2] = max(b[0] + 1, b[2])
        b[3] = max(b[1] + 1, b[3])
        d = {k: v for k, v in it.items() if k not in ("box",)}
        d["bbox"] = b
        items.append(d)
    return {"width": width, "height": height, "bbox_coord_space": "abs", "bbox_format": "xyxy",
            "summary": norm.get("summary") or {"caption": "A composed image."}, "items": items}
