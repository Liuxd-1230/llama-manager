"""Agent 运行时：组装上下文（工作台快照 + 手动改动 + 对话记忆）、流式工具循环、待确认改动、滚动摘要。"""

from __future__ import annotations

import asyncio
import base64
import copy
import json
import re
from typing import Any, AsyncIterator, Optional

from . import db, llm
from .agent_tools import (TOOL_LABELS, TOOLS, TagFilter, brief_args, parse_args, parse_tool_tags,
                          strip_tool_tags, tags_protocol_text)
from .config import ATTACH_DIR, load_settings
from .layout_core import _is_cjk, camera_phrase, compile_checks
from .lighting import lighting_phrase
from .ops import ToolError, Workbench, describe_changes, describe_doc
from .skills import load_skills

MAX_STEPS = 10


def _claims_modification(text: str) -> bool:
    # Server-owned audit phrases copied into plain prose are not tool calls.
    ledger = r'(?m)^\s*\[(?:执行的操作|改动「)[^\n]*(?:→成功|用户已采纳)'
    claim = r'(?m)^\s*(?:好的[，,。]\s*)?(?:我)?(?:已经|已)(?:修改|更新|添加|替换|调整|删除)|(?m:^\s*(?:改动|修改)已完成)'
    return bool(re.search(ledger, text) or re.search(claim, text))


SYSTEM_BASE = """你是「MOSS 提示词工作台」的 Agent，和用户一起讨论、编写、修改 MOSS-Image 的 Layout（分区布局）和 Caption（散文）提示词。

## 工作方式
- 你能看到工作台的实时状态（每轮在 <workbench> 中给出）：当前页面、同系列其他页面、用户选中的框、用户自上次以来的手动改动。
- 修改只能通过真实工具调用完成，不能在回复里仿写「[执行的操作]」「用户已采纳」等系统记录。未调用工具时不能声称已修改；采纳状态由用户界面决定。不要在回复里贴整段 JSON。你的改动会以「待确认改动」卡片给用户逐条采纳或驳回。
- 用户只是讨论、提问时，直接回答，不要调用修改工具。意图不明确、有多种合理方向时，用 ask_user 给选项。
- 改动尽量小：只改用户提到的或必须联动的部分。用户手动改过的地方视为用户的决定，不要改回去。
- 锁定（locked）的框只读；隐藏（hidden）的框保留不动。
- group 相同的框是用户绑定的一组（比如人物和手里的道具）：改位置或大小时整组一起改、保持组内相对位置，不要把它们拆开，也不要擅自改 group。新加人物手里的道具 / 配件时，可以把它的 group 设成和这个人物相同（人物已有组就沿用那个值，没有就给两者起一个简短的新组名，如 g1）。
- 回复用简洁的中文：先说结论，再列关键改动。不要复述整份布局，也不要把改好的整段提示词贴进回复（用户在卡片和画布上能看到）。
- 回复是普通 Markdown，不要整段包在代码块里。
- 当前页是 Layout 时，提示词只由整体描述（summary）和各框组成；除非用户明确要求写成 Caption，不要调用 set_caption。

## 坐标与图层
- 坐标是画布绝对像素，原点在左上角，x 向右、y 向下，bbox = [x1,y1,x2,y2]。坐标换算由程序完成：你可以按别的画布尺寸写（在 replace_layout 里给出 width/height），程序会等比缩放居中。
- layers_back_to_front 的顺序就是图层顺序，越靠后越靠前（离镜头越近，会遮挡前面的框）。背景在前，前景主体在后。
- 框可以重叠。文字（label=text）把要画出来的字原样写进 text。
- 引用框时用 id 或图层名（name）。新框要起简短的中文名。

## 描述写法（MOSS-Image 约定）
- summary.caption 写整张图；每个框的 caption 只写这个框里看得见的东西（外观、动作、材质、光线），不要把别的框的主体写进来。
- 默认英文（用户明确要中文时用中文）；不写坐标、不写质量堆砌词、不写看不见的过程。
- 保持用户给定的主体、数量、关系、风格和排除项。

## 摄像机与体块（3D）
- 摄像机参数：orbit 环绕（正=镜头绕到右侧）、pitch 俯仰（正=升高俯拍，负=仰拍）、roll 滚转（荷兰角）、distance 距离（<1 推近）、fov 视角（50 标准，大=广角，小=长焦）、pan 平移。
- 每个框可有 body：z 远近（1=主体平面，<1 更近）、thickness 厚度（相对框宽）、yaw 朝向、anchor（world 立体物 / screen 贴在画面上的字和贴纸 / backdrop 铺满的背景）。
- 摄像机开启时，框位由体块按机位投影得到（workbench 里的 view_bbox 是当前镜头下的框）。
- 「按视角改描述」：框位、图层、可见文字都不动，只用 update_items 改写各框 caption 和 summary.caption，使其符合当前机位（比如俯拍能看到头顶与地面、仰拍能看到下巴和帽檐底面、侧面只见一只眼）。

## 灯光
- 灯光在 workbench 的 lighting 里：每盏灯有 role（key 主光 / fill 补光 / rim 轮廓光 / bg 背景光 / practical 实景光源）、azimuth（相对当前机位：0=正面，负=画面左，正=画面右，±180=主体背后）、elevation（高度角，正=从上方）、intensity、kelvin 或 color、softness（0 硬光…1 柔光），in_frame 是它在画面里的方向。
- 用 set_lighting 改灯光：套预设（preset）、整体重写（lights）或改某几盏（update_lights）。方位都相对当前机位。
- 灯光开启时，编译会把「当前灯光语言」追加到整体描述，所以 summary.caption 里不要再写和它矛盾的光线。
- 「按灯光改描述」：框位、图层、文字都不动，只用 update_items / update_summary 改写描述，让亮面、阴影、高光、轮廓光、色温和灯光一致（例如主光从左上方来：左脸亮、右脸落在阴影里，地面投影朝右下）。

## 多页
- 同一系列的页面共用这场对话。用户要多个版本/方案时，用 create_page 新建页面再写；需要参照别的页时用 view_page。
"""

DRAFT_GUIDE = """## 本轮任务：AI 起稿（根据文字描述生成布局）
用户给了一段画面描述，你要直接把它变成完整、可编译的 Layout：自己决定所有细节，不要提问、不要只给建议。
- 写入方式按用户消息里的要求：替换当前页 → 调用一次 replace_layout；追加到当前页 → add_items（不动已有的框）；新建一页 → 先 create_page，再 replace_layout。
- 画布：用户说「由 AI 决定」时按内容选尺寸（人物全身 / 竖构图 1024×1536，横向场景 / 载具 / 多人 1536×1024，方形 1024×1024），在 replace_layout 里给 width/height 并设 resize_canvas=true；否则按当前画布的像素坐标写。
- 拆框：描述里每个看得见的主体、重要道具、背景环境各一个框，一般 3–8 个。整张背景（街道、天空、房间、荒野）用一个铺满画布的框放在最底层，body.anchor=backdrop。
- 构图：主体放在三分线附近，占画面高度 40–70%；人物全身框宽高比约 1:2.5–1:3，半身约 1:1.3；框要完整，不贴边（故意出画的前景除外）。
- 远近：站在地面上的东西，越远底边越高（越接近地平线，地平线约在画面高度 40–45% 处）、框越小；大小按真实尺寸和远近换算（人约 1.8 m；汽车约 1.5 m 高、4.5 m 长；坦克约 3 m 高、7 m 长；房子 6–10 m 高）。「后面跟着 / 身后 / 远处」的东西在主体后方：图层更靠底（数组更靠前）、底边更高；它本身更大时框也可以比主体大。前景遮挡物在最上层。
- 手持物 / 穿戴物（枪、剑、包、旗、杯子、头盔等）单独一个框，和持有者重叠在手（或头、背）的位置，图层放在持有者之后（更靠前），group 设成和持有者相同的组名（如 g1；没有就给两者起一个）。
- body：每个框都写 body。z：主体 1，身后的东西按距离 1.5–4，前景 0.5–0.8；thickness：人物 0.45，物体 0.3–0.8，薄片 0.1；yaw：侧身 / 斜向时给角度（正值=向画面右侧转）；背景 anchor=backdrop，文字 / 标志 anchor=screen。
- 描述：每个框的 caption 用英文写这个框里看得见的东西（外观、服装、材质、动作、朝向、颜色），20–60 词；summary.caption 写整张图（主体关系、场景、时间、氛围、画风），60–120 词；name 用 2–6 个字的中文。文字元素用 label=text，把要画的字写进 text。用户明确要中文描述时改用中文。
- 机位 / 灯光：用户要求时，用 set_camera（描述里提到仰拍、俯拍、广角、特写就照做；没提就保持平视，只设 enabled=true）和 set_lighting（按场景选最合适的预设，必要时再调色温、方位、氛围）。
- 写完用 1–3 句中文说明构图思路（谁在哪、前后远近、机位和灯光）。
"""


def _skills_block(kind: str, extra_ids: list[str]) -> str:
    store = load_skills()
    by_id = {s["id"]: s for s in store["skills"]}
    picked: list[dict] = []
    for sid in [store["active"].get(kind), store["active"].get("context"), *extra_ids]:
        s = by_id.get(sid or "")
        if s and s not in picked:
            picked.append(s)
    if not picked:
        return ""
    # Verbatim on purpose: the skill text is the user's instruction set, injected
    # in full with no disclaimers and no trimming beyond outer whitespace.
    parts = ["## 写法参考（Skill）"]
    for s in picked:
        parts.append(f"### {s['name']}\n{s['system_prompt'].strip()}")
    return "\n\n".join(parts)


def _turn_text(m: dict) -> str:
    meta = m.get("meta") or {}
    if m["role"] == "user":
        t = m.get("content") or ""
        if meta.get("attachments"):
            t += f"\n[附图 {len(meta['attachments'])} 张]"
        return t
    content = m.get("content") or ""
    steps = meta.get("steps") or []
    if _claims_modification(content) and not steps and not meta.get('proposals'):
        content = '（此历史回复没有实际工具或改动提案记录，不能作为页面已更新的依据。）'
    lines = [content]
    if steps:
        lines.append("[执行的操作] " + "；".join(
            f"{s.get('name')}({s.get('brief', '')})→{'成功' if s.get('ok') else '失败'}" for s in steps[:12]))
    for p in meta.get("proposals") or []:
        st = {"accepted": "用户已采纳", "rejected": "用户已驳回", "partial": "用户部分采纳",
              "pending": "待用户确认"}.get(p.get("status"), p.get("status"))
        lines.append(f"[改动「{p.get('page_name')}」：{st}]")
    if meta.get("ask"):
        lines.append(f"[向用户提问] {meta['ask'].get('question')} 选项：{' / '.join(meta['ask'].get('options') or [])}")
    if meta.get("stopped"):
        lines.append("[本轮被用户中止]")
    return "\n".join(x for x in lines if x)


def _image_part(att_id: str) -> Optional[dict]:
    for p in ATTACH_DIR.glob(f"{att_id}.*"):
        mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp",
                "gif": "image/gif"}.get(p.suffix.lstrip(".").lower(), "image/png")
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
    return None


def build_messages(*, session: dict, history: list[dict], wb: Workbench, page_id: str, doc: dict,
                   view: Optional[dict], user_text: str, selection: list[str], skill_ids: list[str],
                   attachments: list[str], protocol: str, mode: Optional[str] = None) -> tuple[list[dict], list[str]]:
    from ..atelier.providers import request_settings
    s = request_settings()
    meta = session.get("meta") or {}
    kind = db.normalize_doc(doc)["kind"]
    system = SYSTEM_BASE
    if mode == "draft":
        system += "\n\n" + DRAFT_GUIDE
    sk = _skills_block(kind, skill_ids)
    if sk:
        system += "\n\n" + sk
    if protocol == "tags":
        system += "\n\n" + tags_protocol_text()
    msgs: list[dict] = [{"role": "system", "content": system}]

    upto = int(meta.get("summary_upto") or 0)
    if meta.get("summary"):
        msgs.append({"role": "user", "content": f"（更早对话的摘要，供你参考）\n{meta['summary']}"})
        msgs.append({"role": "assistant", "content": "好的，我记得这些。"})
    turns = [m for m in history if m["seq"] > upto and m["role"] in ("user", "assistant")]
    # 最近 N 轮（一轮 = 一条用户消息起）
    user_idx = [i for i, m in enumerate(turns) if m["role"] == "user"]
    keep_from = user_idx[-s["context_turns"]] if len(user_idx) > s["context_turns"] else 0
    for m in turns[keep_from:]:
        t = _turn_text(m)
        if t.strip():
            msgs.append({"role": m["role"], "content": t})

    # 工作台快照
    name = wb.names.get(page_id, page_id)
    vitems = (view or {}).get("items") if isinstance(view, dict) else None
    wsl = ["<workbench>", "当前页面（你的修改默认写在这里）：", describe_doc(doc, name, page_id, vitems)]
    nd = db.normalize_doc(doc)
    L = nd["layout"]
    cam = L.get("camera") or {}
    if nd["kind"] == "layout" and cam.get("enabled"):
        zh = _is_cjk((L.get("summary") or {}).get("caption", ""))
        ph = camera_phrase(cam, L.get("items") or [], L["width"], L["height"], zh)
        wsl.append(f"当前镜头语言（编译时会追加到整体描述）：{ph or '中性平视，无追加'}")
    lg = L.get("lighting") or {}
    if nd["kind"] == "layout" and isinstance(lg, dict) and lg.get("enabled"):
        zh = _is_cjk((L.get("summary") or {}).get("caption", ""))
        lph = lighting_phrase(lg, cam if cam.get("enabled") else None, zh)
        wsl.append(f"当前灯光语言（编译时会追加到整体描述）：{lph or '无'}")
    others = [describe_doc(wb.base[pid], wb.names.get(pid, pid), pid, brief=True)
              for pid in wb.names if pid != page_id and pid in wb.base]
    if others:
        wsl.append("同系列其他页面：\n" + "\n".join(f"- {o}" for o in others))
    if selection:
        items = {it.get("id"): it for it in L.get("items") or []}
        sel = [f"「{items[i].get('name') or i}」(id={i})" for i in selection if i in items]
        if sel:
            wsl.append("用户当前选中：" + "、".join(sel) + "（用户说“这个/它”时通常指这些）")
    # The compiled prompt is the actual artifact the user feeds to ComfyUI; the
    # agent must see it verbatim or it will keep proposing changes to a text it
    # has never read.
    compiled = str((view or {}).get("compiled") or "").strip() if isinstance(view, dict) else ""
    if compiled:
        wsl.append("当前页面编译出的最终提示词（送 ComfyUI 的就是这段）：\n" + compiled)
    seen = (meta.get("seen") or {}).get(page_id)
    manual = describe_changes(seen, doc) if seen else []
    if manual:
        wsl.append("用户自上次对话以来的手动改动：\n" + "\n".join(f"- {x}" for x in manual[:30]))
    wsl.append("</workbench>")
    final_text = "\n".join(wsl) + "\n\n用户：" + user_text
    parts: list[dict] = []
    for a in attachments[:4]:
        p = _image_part(a)
        if p:
            parts.append(p)
    if parts:
        msgs.append({"role": "user", "content": [{"type": "text", "text": final_text}, *parts]})
    else:
        msgs.append({"role": "user", "content": final_text})
    return msgs, manual


def sse(ev: dict) -> str:
    return "data: " + json.dumps(ev, ensure_ascii=False) + "\n\n"


async def run_agent(*, session_id: str, page_id: str, doc: dict, view: Optional[dict], message: str,
                    selection: list[str], skill_ids: list[str], attachments: list[str],
                    replace_from_seq: Optional[int], quick: Optional[str], mode: Optional[str] = None) -> AsyncIterator[str]:
    session = db.get_session(session_id)
    if not session:
        yield sse({"type": "error", "message": "会话不存在"})
        return
    page = db.get_page(page_id)
    if not page:
        yield sse({"type": "error", "message": "页面不存在"})
        return
    from ..atelier.providers import request_settings
    s = request_settings()
    from .bridge import resolve, ProviderError
    try:
        resolve(s.get("provider_id"))
    except ProviderError as exc:
        yield sse({"type": "error", "message": f"{exc}。画框、编辑与编译不受影响。"})
        return

    if replace_from_seq:
        db.delete_messages_from(session_id, int(replace_from_seq))
    history = db.list_messages(session_id)
    # 用户消息先落库：中途断开也不丢
    umsg = db.add_message(session_id, "user", message, {
        "page_id": page_id, "selection": selection, "skill_ids": skill_ids,
        "attachments": attachments, "quick": quick})
    if not history and session.get("title") in ("新对话", "", None):
        title = (quick or "").strip() or (message.strip().splitlines() or ["对话"])[0]
        db.update_session(session_id, title=title[:24])
    yield sse({"type": "user_saved", "message": umsg})

    # 当前文档以客户端为准（可能还没自动保存）
    db.update_page(page_id, doc=doc)
    wb = Workbench(session["series_id"], page_id)
    wb.set_current_doc(page_id, doc)
    meta = dict(session.get("meta") or {})
    protocol = meta.get("protocol") or ("tags" if s["agent_protocol"] == "tags" else "tools")
    msgs, _manual = build_messages(session=session, history=history, wb=wb, page_id=page_id, doc=doc, view=view,
                                   user_text=message, selection=selection, skill_ids=skill_ids,
                                   attachments=attachments, protocol=protocol, mode=mode)
    from ..atelier import mcp, store
    for identifier in doc.get('asset_ids',[]):
        try: asset=store.get_object(identifier)
        except KeyError: continue
        if asset['kind']=='preset':
            s={**s,'temperature':float(asset['data'].get('temperature',.7)),'top_p':float(asset['data'].get('top_p',.95))}
        if asset['kind'] in ('character','preset','artist','tag','notebook','lora'):
            msgs.insert(1,{'role':'system','content':'User-selected creative reference; explicit requests override defaults: '+json.dumps({'kind':asset['kind'],'name':asset['name'],'data':asset['data']},ensure_ascii=False)})
    tools = [t for t in TOOLS if t["function"]["name"] != "ask_user"] if mode == "draft" else list(TOOLS)
    tools = [*tools, *(await mcp.tool_schemas())]
    meta.setdefault("seen", {})[page_id] = copy.deepcopy(doc)

    visible: list[str] = []
    reasoning: list[str] = []
    steps: list[dict] = []
    model_used = ""
    error: Optional[str] = None
    stopped = True
    repaired = False
    execution_repaired = False
    try:
        step = 0
        while step < MAX_STEPS:
            step += 1
            filt = TagFilter() if protocol == "tags" else None
            done: dict = {}
            try:
                async for kind, val in llm.stream_chat(msgs, tools=tools if protocol == "tools" else None, temperature=s.get("temperature",.7), top_p=s.get("top_p")):
                    if kind == "model":
                        if val != model_used:
                            model_used = val
                            yield sse({"type": "model", "model": val})
                    elif kind == "reasoning":
                        # Thinking models stream their chain of thought here; the
                        # UI shows it in a collapsible block, separate from the answer.
                        reasoning.append(val)
                        yield sse({"type": "reasoning", "delta": val})
                    elif kind == "text":
                        out = filt.feed(val) if filt else val
                        if out:
                            visible.append(out)
                            yield sse({"type": "text", "delta": out})
                    elif kind == "tool_delta":
                        yield sse({"type": "tool_pending", "name": val["name"],
                                   "label": TOOL_LABELS.get(val["name"], val["name"])})
                    elif kind == "done":
                        done = val
            except llm.ToolsUnsupported:
                if s["agent_protocol"] == "auto" and protocol == "tools":
                    protocol = "tags"
                    meta["protocol"] = "tags"
                    msgs[0]["content"] += "\n\n" + tags_protocol_text()
                    yield sse({"type": "notice", "message": "当前接口不支持函数调用，已切换到标签协议"})
                    step -= 1
                    continue
                raise
            if filt:
                tail = filt.flush()
                if tail:
                    visible.append(tail)
                    yield sse({"type": "text", "delta": tail})
            content = done.get("content") or ""
            calls = done.get("tool_calls") or []
            if protocol == "tags":
                calls = parse_tool_tags(content)
            if not calls:
                changed = wb.changed_pages()
                missing_action = not changed and not any(st.get('ok') for st in steps) and (_claims_modification(content) or mode == 'draft')
                if missing_action:
                    # Never parse a prose pseudo-call into an operation. Ask for
                    # real tool output once; do not repeat successful side effects.
                    visible.clear()
                    yield sse({'type':'text_reset'})
                    if execution_repaired:
                        error = '模型未执行实际修改，画面未改变。请重试或更换支持工具调用的模型。'
                        break
                    execution_repaired = True
                    yield sse({'type':'notice','message':'尚未执行修改，正在重试工具调用…'})
                    msgs.append({'role':'assistant','content':content})
                    msgs.append({'role':'user','content':'系统核对：刚才没有实际工具调用，页面没有任何修改。请使用提供的真实工具完成请求；不要仿写操作记录、不要声称用户已采纳。若无法执行，请说明原因。'})
                    continue
                if changed and not repaired:
                    probs = []
                    for pid in changed:
                        d = wb.working[pid]
                        target = d["layout"] if d["kind"] == "layout" else d["caption"]
                        for p in compile_checks(target):
                            probs.append(f"「{wb.names.get(pid, pid)}」{p}")
                    if probs:
                        repaired = True
                        yield sse({"type": "notice", "message": "自检发现问题，正在修正：" + "；".join(probs[:4])})
                        msgs.append({"role": "assistant", "content": content or "（已完成修改）"})
                        msgs.append({"role": "user", "content": "系统自检发现这些问题，请直接用工具修正，修完用一句话说明：\n- "
                                     + "\n- ".join(probs[:12])})
                        visible.append("\n\n")
                        continue
                break
            # 执行工具
            if protocol == "tools":
                msgs.append({"role": "assistant", "content": content or None, "tool_calls": [
                    {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}}
                    for c in calls]})
            else:
                msgs.append({"role": "assistant", "content": content})
            results = []
            asked = False
            for c in calls:
                name = c["name"]
                try:
                    args = parse_args(c["arguments"])
                except (ValueError, json.JSONDecodeError) as e:
                    args, res, ok = {}, f"参数解析失败：{e}。请输出合法 JSON 再调用一次。", False
                else:
                    if name == "ask_user":
                        opts = [str(o)[:60] for o in (args.get("options") or []) if str(o).strip()][:6]
                        wb.ask = {"question": str(args.get("question") or "")[:300], "options": opts,
                                  "multi": bool(args.get("multi"))}
                        res, ok, asked = "已向用户提问，等待回答。", True, True
                        yield sse({"type": "ask", **wb.ask})
                    else:
                        try:
                            res, ok = (await mcp.call(name, args) if name.startswith("mcp_") else wb.run(name, args)), True
                        except ToolError as e:
                            res, ok = f"失败：{e}", False
                        except Exception as e:  # noqa: BLE001 — 工具异常回给模型
                            res, ok = f"失败：{type(e).__name__}: {e}", False
                for pg in wb.created:
                    if not any(x.get("page_id") == pg["id"] for x in steps if x.get("created")):
                        yield sse({"type": "page_created", "page": pg})
                        steps.append({"name": "create_page", "brief": pg["name"], "ok": True, "created": True,
                                      "page_id": pg["id"], "result": ""})
                if name != "create_page":
                    st = {"name": name, "label": TOOL_LABELS.get(name, name), "brief": brief_args(name, args),
                          "ok": ok, "result": res[:400]}
                    steps.append(st)
                    yield sse({"type": "tool", **st})
                results.append((c, res))
            if protocol == "tools":
                for c, res in results:
                    msgs.append({"role": "tool", "tool_call_id": c["id"], "content": res})
            else:
                msgs.append({"role": "user", "content": "<tool_results>\n" + "\n".join(
                    f"{c['name']}: {res}" for c, res in results) + "\n</tool_results>"})
            if asked:
                break
        stopped = False
    except llm.UpstreamError as e:
        error = str(e)
        stopped = False
    except asyncio.CancelledError:
        stopped = True
        raise
    except Exception as e:  # noqa: BLE001
        error = f"{type(e).__name__}: {e}"
        stopped = False
    finally:
        proposals = []
        for pid in wb.changed_pages():
            base, prop = wb.base[pid], wb.working[pid]
            proposals.append({"page_id": pid, "page_name": wb.names.get(pid, pid), "base": base,
                              "proposed": prop, "summary": describe_changes(base, prop), "status": "pending"})
            meta["seen"][pid] = copy.deepcopy(prop)
        text = strip_tool_tags("".join(visible)).strip()
        if not text and proposals:
            text = "已提交改动，请在下方确认。"
        if error and not text:
            text = ""
        amsg = db.add_message(session_id, "assistant", text, {
            "steps": steps, "proposals": proposals, "ask": wb.ask, "model": model_used,
            "error": error, "stopped": stopped, "page_id": page_id,
            "reasoning": "".join(reasoning).strip() or None})
        fresh = db.get_session(session_id) or session
        fmeta = dict(fresh.get("meta") or {})
        fmeta["seen"] = {**(fmeta.get("seen") or {}), **meta["seen"]}
        if meta.get("protocol"):
            fmeta["protocol"] = meta["protocol"]
        db.update_session(session_id, meta=fmeta)
        if not stopped:
            for p in proposals:
                yield sse({"type": "proposal", "message_id": amsg["id"], **p})
            if error:
                yield sse({"type": "error", "message": error})
            yield sse({"type": "done", "message": amsg})
            asyncio.get_event_loop().create_task(maybe_summarize(session_id))


async def maybe_summarize(session_id: str) -> None:
    """对话超出保留轮数时，把更早的轮次压成摘要（失败就算了，下次再试）。"""
    try:
        s = load_settings()
        sess = db.get_session(session_id)
        if not sess:
            return
        meta = dict(sess.get("meta") or {})
        upto = int(meta.get("summary_upto") or 0)
        msgs = [m for m in db.list_messages(session_id) if m["seq"] > upto]
        users = [m for m in msgs if m["role"] == "user"]
        keep = s["context_turns"]
        if len(users) <= keep + 4:
            return
        cut_seq = users[-keep]["seq"]
        old = [m for m in msgs if m["seq"] < cut_seq]
        transcript = "\n".join(f"{'用户' if m['role'] == 'user' else 'Agent'}：{_turn_text(m)[:600]}" for m in old)
        prev = meta.get("summary") or ""
        prompt = ("把下面这段提示词工作台的对话压缩成要点摘要（中文，≤400 字），保留：用户的目标与偏好、"
                  "已确定的构图/风格/文字、被否决的方向、还没解决的问题。只输出摘要。\n\n"
                  + (f"已有摘要：\n{prev}\n\n" if prev else "") + f"新对话：\n{transcript}")
        out = await llm.chat([{"role": "user", "content": prompt}], max_tokens=900, temperature=0.3)
        meta["summary"] = out.strip()[:2000]
        meta["summary_upto"] = cut_seq - 1
        latest = db.get_session(session_id) or sess
        lm = dict(latest.get("meta") or {})
        lm.update({"summary": meta["summary"], "summary_upto": meta["summary_upto"]})
        db.update_session(session_id, meta=lm)
    except Exception:  # noqa: BLE001
        return
