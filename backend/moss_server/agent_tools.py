"""Agent 可用的工具（OpenAI function calling 格式）与标签块协议说明。"""

from __future__ import annotations

import json
import re
from typing import Any

_BBOX = {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 4,
         "description": "[x1,y1,x2,y2] 画布左上角为原点的绝对像素"}
_BODY = {
    "type": "object",
    "description": "3D 体块，用于摄像机机位推导",
    "properties": {
        "z": {"type": "number", "description": "离镜头远近，1.0=主体所在平面，<1 更近，>1 更远（0.15–12）"},
        "thickness": {"type": "number", "description": "沿视线方向的厚度，相对框宽（0=薄片，0.5=人物躯干，1=立方体）"},
        "yaw": {"type": "number", "description": "朝向角（度），0=正对镜头，正值向右转"},
        "anchor": {"type": "string", "enum": ["world", "screen", "backdrop"],
                   "description": "world=场景中的立体物；screen=贴在画面上的字/贴纸/UI，不随镜头动；backdrop=铺满的背景"},
    },
}
_ITEM_PROPS = {
    "name": {"type": "string", "description": "图层名（简短中文，便于引用）"},
    "label": {"type": "string", "enum": ["object", "character", "text"]},
    "bbox": _BBOX,
    "caption": {"type": "string", "description": "该框内可见内容的描述"},
    "text": {"type": "string", "description": "label=text 时要画出来的文字原文"},
    "tags": {"type": "array", "items": {"type": "string"}},
    "palette": {"type": "array", "items": {"type": "string"}},
    "depth": {"type": "string", "enum": ["auto", "fg", "mg", "bg"], "description": "前景/中景/背景"},
    "body": _BODY,
    "group": {"type": "string", "description": "成组：同一个组名的框是一体的（人物和手里的道具），空串=解散"},
}

_LIGHT = {
    "type": "object",
    "properties": {
        "role": {"type": "string", "enum": ["key", "fill", "rim", "bg", "practical"],
                 "description": "key 主光 / fill 补光 / rim 轮廓光 / bg 背景光 / practical 画面里看得见的实景光源（灯、蜡烛、霓虹）"},
        "azimuth": {"type": "number", "description": "相对当前机位的方位（度）：0=从镜头方向照（正面光），-90=画面左侧，90=画面右侧，±180=主体正后方（逆光）"},
        "elevation": {"type": "number", "description": "高度角（度）：0=平视高度，45=斜上方，85=顶光，负值=底光"},
        "intensity": {"type": "number", "description": "强度 0–2，1=正常"},
        "kelvin": {"type": "number", "description": "色温 K：1900 烛光、2800 夕阳、3200 钨丝灯、5600 日光、8000+ 冷蓝；要彩色光时不填，改填 color"},
        "color": {"type": "string", "description": "彩色光 #rrggbb（如霓虹 #ff2e88）"},
        "softness": {"type": "number", "description": "0=硬光（清晰阴影）… 1=柔光（漫射）"},
        "enabled": {"type": "boolean"},
    },
}


def _fn(name: str, desc: str, props: dict, required: list[str] | None = None) -> dict:
    return {"type": "function", "function": {"name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required or []}}}


TOOLS: list[dict] = [
    _fn("update_summary", "修改当前页的整体描述 summary（caption / meta 类型词 / canvas 画布类型 / palette）。", {
        "caption": {"type": "string"},
        "meta": {"type": "array", "items": {"type": "string"}},
        "canvas": {"type": "string", "enum": ["single", "multi_panel", "collage"]},
        "palette": {"type": "array", "items": {"type": "string"}},
    }),
    _fn("add_items", "在当前页新增一个或多个框。默认放到最前（数组末尾）；insert_at 为层号（1=最底）。", {
        "items": {"type": "array", "items": {"type": "object", "properties": {
            **_ITEM_PROPS, "insert_at": {"type": "integer"}}, "required": ["label", "bbox", "caption"]}},
    }, ["items"]),
    _fn("update_items", "修改已有框，只写要改的字段。ref 可用 id、图层名或 #层号。锁定的框不能改。", {
        "updates": {"type": "array", "items": {"type": "object", "properties": {
            "ref": {"type": "string"}, **_ITEM_PROPS, "hidden": {"type": "boolean"}}, "required": ["ref"]}},
    }, ["updates"]),
    _fn("remove_items", "删除框。", {"refs": {"type": "array", "items": {"type": "string"}}}, ["refs"]),
    _fn("reorder_items", "调整图层前后：按从后到前列出要重排的框，未列出的框位置不变。", {
        "order": {"type": "array", "items": {"type": "string"}},
    }, ["order"]),
    _fn("replace_layout", "整页重写布局（新构图 / 大改时用）。可按任意画布尺寸写坐标并给出 width/height，"
        "程序会等比缩放并居中到当前画布；resize_canvas=true 时改用你给的尺寸作为画布。名字相同的旧框会继承编辑器设置，锁定框自动保留。", {
        "summary": {"type": "object", "properties": {
            "caption": {"type": "string"}, "meta": {"type": "array", "items": {"type": "string"}},
            "canvas": {"type": "string", "enum": ["single", "multi_panel", "collage"]},
            "palette": {"type": "array", "items": {"type": "string"}}}, "required": ["caption"]},
        "items": {"type": "array", "items": {"type": "object", "properties": _ITEM_PROPS,
                                             "required": ["label", "bbox", "caption"]}},
        "width": {"type": "number"}, "height": {"type": "number"},
        "resize_canvas": {"type": "boolean"},
    }, ["summary", "items"]),
    _fn("set_canvas_size", "改画布尺寸（自动取 16 的倍数），scale_items 默认按比例缩放现有框。", {
        "width": {"type": "number"}, "height": {"type": "number"}, "scale_items": {"type": "boolean"},
    }, ["width", "height"]),
    _fn("set_camera", "设置摄像机机位（会开启 3D 镜头）。只写要改的参数。", {
        "enabled": {"type": "boolean"},
        "orbit": {"type": "number", "description": "环绕角（度，-180..180），正值=镜头绕到主体右侧"},
        "pitch": {"type": "number", "description": "俯仰（度，-85..85），正值=镜头升高向下俯拍，负值=仰拍"},
        "roll": {"type": "number", "description": "滚转（度），荷兰角"},
        "distance": {"type": "number", "description": "距离倍数，1=初始，<1 推近，>1 拉远"},
        "fov": {"type": "number", "description": "视角（度，10..120），50=标准，大=广角，小=长焦"},
        "pan_x": {"type": "number"}, "pan_y": {"type": "number"}, "pan_z": {"type": "number"},
    }),
    _fn("set_lighting", "设置灯光（镜头调度里的灯光），编译时会把灯光描述追加到整体描述。可以只给 preset 套用预设，"
        "也可以用 lights 整体重写灯位、用 update_lights 改某几盏灯。方位都相对当前机位。", {
        "enabled": {"type": "boolean", "description": "默认 true"},
        "preset": {"type": "string", "description": "预设 id 或中文名：natural 自然光、rembrandt 伦勃朗光、butterfly 蝴蝶光、loop 环形光、split 分割光、"
                   "three_point 三点布光、rim 轮廓光、backlight 逆光、silhouette 剪影、golden_hour 黄金时刻、blue_hour 蓝调时刻、"
                   "overcast 阴天柔光、window 窗户光、top 顶光、under 底光、moonlight 月光、neon 霓虹、candle 烛光、spotlight 舞台聚光、"
                   "high_key 高调光、low_key 低调光、noon 正午硬光"},
        "lights": {"type": "array", "items": _LIGHT, "description": "整体重写所有灯（最多 8 盏）"},
        "update_lights": {"type": "array", "items": {"type": "object", "properties": {
            "ref": {"type": "string", "description": "灯的 id 或角色（key/fill/rim/bg/practical）"}, **_LIGHT["properties"]},
            "required": ["ref"]}},
        "remove_lights": {"type": "array", "items": {"type": "string"}, "description": "要删除的灯 id 或角色"},
        "ambient": {"type": "number", "description": "环境光 0–1（0.05 很暗的低调，0.35 正常，0.8 明亮高调）"},
        "ambient_kelvin": {"type": "number", "description": "环境光色温 K"},
        "extras": {"type": "array", "items": {"type": "string"}, "description": "氛围效果：volumetric 体积光、haze 薄雾、flare 镜头光晕、"
                   "bokeh 背景光斑、shadows 清晰投影、blinds 百叶窗光影、dappled 树影斑驳、wet 湿地反光、bloom 柔光辉光、caustics 水波焦散"},
        "note": {"type": "string", "description": "补充的光线描述，原样追加（和整体描述同一种语言）"},
        "follow_camera": {"type": "boolean", "description": "true=灯跟着机位转；false（默认）=灯固定在场景里"},
    }),
    _fn("set_bodies", "给框设置 3D 体块（远近 z、厚度、朝向 yaw、锚定方式），框位与描述不变。", {
        "bodies": {"type": "array", "items": {"type": "object", "properties": {
            "ref": {"type": "string"}, **_BODY["properties"]}, "required": ["ref"]}},
    }, ["bodies"]),
    _fn("set_caption", "写入当前页的 Caption 散文（Caption 模式，无坐标）。activate 默认把页面切到 Caption。", {
        "caption": {"type": "string"}, "activate": {"type": "boolean"},
    }, ["caption"]),
    _fn("create_page", "在当前系列新建一页（多个版本 / 方案时用），之后的修改都写到新页。", {
        "name": {"type": "string"}, "kind": {"type": "string", "enum": ["layout", "caption"]},
        "width": {"type": "number"}, "height": {"type": "number"},
    }, ["name"]),
    _fn("switch_page", "切换要修改的页面（页面 id 或名称）。", {"page": {"type": "string"}}, ["page"]),
    _fn("view_page", "查看同系列另一页的完整内容。", {"page": {"type": "string"}}, ["page"]),
    _fn("ask_user", "需要用户做选择时提问（会结束本轮，等用户回答）。选项 2–6 个，简短。", {
        "question": {"type": "string"},
        "options": {"type": "array", "items": {"type": "string"}},
        "multi": {"type": "boolean", "description": "是否多选"},
    }, ["question", "options"]),
]

TOOL_NAMES = {t["function"]["name"] for t in TOOLS}


def tags_protocol_text() -> str:
    lines = [
        "## 工具调用（标签协议）",
        "当前接口不支持原生函数调用。需要修改工作台时，在回复里写工具标签，每个标签一行开头，参数是严格 JSON：",
        '<tool name="update_items">{"updates":[{"ref":"主体","caption":"..."}]}</tool>',
        "可以连续写多个标签；写完标签就停止输出，等待 <tool_results>，再继续。标签内容用户看不到，所以标签外要用中文说明你做了什么。",
        "可用工具：",
    ]
    for t in TOOLS:
        f = t["function"]
        props = ", ".join(f["parameters"]["properties"].keys())
        lines.append(f"- {f['name']}({props})：{f['description']}")
    return "\n".join(lines)


_TAG_RE = re.compile(r'<tool\s+name\s*=\s*"([a-z_]+)"\s*>([\s\S]*?)</tool>')


def parse_tool_tags(text: str) -> list[dict]:
    out = []
    for i, m in enumerate(_TAG_RE.finditer(text or "")):
        out.append({"id": f"tag_{i}", "name": m.group(1), "arguments": m.group(2).strip()})
    return out


def strip_tool_tags(text: str) -> str:
    return _TAG_RE.sub("", text or "").strip()


class TagFilter:
    """流式隐藏 <tool ...>...</tool>：可能是标签开头的部分先扣住。"""

    def __init__(self) -> None:
        self.buf = ""
        self.inside = False

    def feed(self, s: str) -> str:
        self.buf += s
        out = []
        while self.buf:
            if self.inside:
                j = self.buf.find("</tool>")
                if j < 0:
                    self.buf = self.buf[-7:] if len(self.buf) > 7 else self.buf
                    # 扣住末尾，等结束标签
                    return "".join(out)
                self.buf = self.buf[j + 7:]
                self.inside = False
                continue
            i = self.buf.find("<tool")
            if i >= 0:
                out.append(self.buf[:i])
                self.buf = self.buf[i:]
                self.inside = True
                continue
            k = self.buf.rfind("<")
            if k >= 0 and "<tool".startswith(self.buf[k:k + 5]) and len(self.buf) - k < 5:
                out.append(self.buf[:k])
                self.buf = self.buf[k:]
                return "".join(out)
            out.append(self.buf)
            self.buf = ""
        return "".join(out)

    def flush(self) -> str:
        rest = "" if self.inside else self.buf
        self.buf = ""
        return rest


def parse_args(raw: str) -> dict:
    raw = (raw or "").strip() or "{}"
    try:
        v = json.loads(raw)
    except json.JSONDecodeError:
        s = raw
        if s.startswith("```"):
            s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s)
        s = re.sub(r",\s*([}\]])", r"\1", s)  # 尾逗号
        try:
            v = json.loads(s)
        except json.JSONDecodeError:
            m = re.search(r"\{[\s\S]*\}", s)
            if not m:
                raise
            v = json.loads(m.group(0))
    if not isinstance(v, dict):
        raise ValueError("参数不是 JSON 对象")
    return v


def brief_args(name: str, args: dict) -> str:
    def nm(x: Any) -> str:
        return str((x or {}).get("name") or (x or {}).get("ref") or "")[:20] if isinstance(x, dict) else str(x)[:20]
    if name in ("add_items", "replace_layout"):
        its = args.get("items") or []
        return f"{len(its)} 个框：" + "、".join(nm(x) for x in its[:6])
    if name == "update_items":
        return "、".join(nm(x) for x in (args.get("updates") or [])[:6])
    if name == "remove_items":
        return "、".join(str(x)[:20] for x in (args.get("refs") or [])[:6])
    if name == "set_bodies":
        return "、".join(nm(x) for x in (args.get("bodies") or [])[:6])
    if name == "set_camera":
        return " ".join(f"{k}={v}" for k, v in args.items())[:80]
    if name == "set_lighting":
        bits = []
        if args.get("preset"):
            bits.append(str(args["preset"]))
        if isinstance(args.get("lights"), list):
            bits.append(f"{len(args['lights'])} 盏灯")
        if isinstance(args.get("update_lights"), list):
            bits.append("调整 " + "、".join(str((x or {}).get("ref", ""))[:10] for x in args["update_lights"][:4]))
        if args.get("enabled") is False:
            bits.append("关闭")
        return " · ".join(bits)[:80]
    if name in ("create_page", "switch_page", "view_page"):
        return str(args.get("name") or args.get("page") or "")[:30]
    if name == "ask_user":
        return str(args.get("question") or "")[:40]
    return ""


TOOL_LABELS = {
    "update_summary": "改整体描述", "add_items": "新增框", "update_items": "修改框", "remove_items": "删除框",
    "reorder_items": "调整图层", "replace_layout": "写入布局", "set_canvas_size": "改画布尺寸",
    "set_camera": "调整机位", "set_lighting": "调整灯光", "set_bodies": "估算体块", "set_caption": "写 Caption", "create_page": "新建页面",
    "switch_page": "切换页面", "view_page": "查看页面", "ask_user": "提问",
}
