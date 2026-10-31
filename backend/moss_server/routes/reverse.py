from __future__ import annotations

"""Image reverse routes: caption recaptioning and layout extraction."""
import base64
import json
import re
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from .. import bridge, config, llm
from ..config import CAPTION_PROMPT_PATH
from ..layout_core import _ensure_wh, _sanitize_layout_draft, compile_safe
from ..reverse_boxes import box_format_for, items_to_draft, normalize_reverse, reverse_rules
from ..skills import resolve_skill
from .sessions import _image_size

router = APIRouter(prefix="/api/v1/moss")


# ---------- 图像反推 ----------
def _load_caption_prompt() -> str:
    if CAPTION_PROMPT_PATH.exists():
        text = CAPTION_PROMPT_PATH.read_text(encoding="utf-8")
        m = re.search(r"```text\n([\s\S]*?)```", text)
        if m:
            return m.group(1).replace("{{reference}}", "(none)")
    return ('You are an image recaptioner. Return exactly one JSON object with schema '
            '{"caption":{"long":"...","medium":"...","short":"..."},"watermark":[],"borders":["none"]}')


LAYOUT_REVERSE_DETAIL = {
    "long": ("Detail level: LONG. Write rich, vivid English captions for summary.caption and every item.caption — "
             "appearance, materials, lighting, pose, spatial relations. Keep visible text exact in the text field "
             "when label is text."),
    "medium": ("Detail level: MEDIUM. Balanced English captions — clear subject, scene, and key traits without "
               "excessive flourish. Keep visible text exact in the text field when label is text."),
    "short": ("Detail level: SHORT. Concise English captions — only essentials for summary and each item. "
              "Keep visible text exact in the text field when label is text."),
}


async def _vision(messages: list[dict], model: str, temperature: float, provider_id: str | None = None) -> str:
    try:
        if provider_id:
            from ...atelier.providers import complete
            return (await complete(messages,model=model,temperature=temperature,provider_id=provider_id)).get('content','')
        return await llm.chat(messages, model=model, max_tokens=8192, temperature=temperature)
    except llm.UpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.post("/reverse")
async def api_reverse(
    file: UploadFile = File(...),
    mode: str = Form("caption"),
    detail: str = Form("medium"),
    width: Optional[int] = Form(None),
    height: Optional[int] = Form(None),
    skill_id: Optional[str] = Form(None),
    image_width: Optional[int] = Form(None),
    image_height: Optional[int] = Form(None),
    provider_id: Optional[str] = Form(None),
):
    s = config.load_settings()
    try:
        bridge.resolve(provider_id or s.get("provider_id"))
    except bridge.ProviderError as exc:
        raise HTTPException(status_code=400, detail=f"无法调用视觉模型做图像反推：{exc}") from exc
    mode = (mode or "caption").strip().lower()
    if mode not in ("caption", "layout"):
        raise HTTPException(status_code=400, detail="mode 必须是 caption 或 layout")
    detail = (detail or "medium").strip().lower()
    if detail not in LAYOUT_REVERSE_DETAIL:
        raise HTTPException(status_code=400, detail="detail 必须是 long|medium|short")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="空文件")
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="图片过大（上限 15MB）")
    mime = file.content_type or "image/jpeg"
    data_url = f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"
    vision_model = s.get("vision_model") or s.get("model") or "gpt-4o"
    if provider_id=='local':
        from ...process_manager import process_manager
        if process_manager.get_status().state!='running' or not config.get_config().mmproj_path:
            raise HTTPException(status_code=409,detail='请先启动带有 MMProj 的视觉 GGUF 档案')
        vision_model=Path(config.get_config().model_path).name

    if mode == "caption":
        messages = [{"role": "user", "content": [
            {"type": "text", "text": _load_caption_prompt()},
            {"type": "image_url", "image_url": {"url": data_url}}]}]
        content = await _vision(messages, vision_model, 0.7, provider_id)
        try:
            result = llm.extract_json(content)
        except (json.JSONDecodeError, ValueError) as e:
            raise HTTPException(status_code=502, detail=f"反推结果无法解析: {e}\n{content[:800]}") from e
        if not isinstance(result.get("caption"), dict):
            if all(k in result for k in ("long", "medium", "short")):
                result = {"caption": {k: str(result.get(k) or "") for k in ("long", "medium", "short")},
                          "watermark": result.get("watermark") or [], "borders": result.get("borders") or ["none"]}
            else:
                raise HTTPException(status_code=502, detail=f"反推缺少 caption 字段: {str(result)[:400]}")
        result["mode"] = "caption"
        result["detail"] = detail
        return result

    img_w, img_h = _image_size(raw)
    img_w = img_w or image_width
    img_h = img_h or image_height
    if width is None or height is None:
        width, height = width or img_w or 1024, height or img_h or 1024
    w, h = _ensure_wh(int(width), int(height))
    skill = resolve_skill("layout", skill_id)
    fmt = box_format_for(vision_model)
    system = (skill["system_prompt"] + "\n\n" + reverse_rules(fmt, img_w, img_h, LAYOUT_REVERSE_DETAIL[detail]))
    messages = [{"role": "system", "content": system}, {"role": "user", "content": [
        {"type": "text", "text": f"请看这张参考图，按要求输出 JSON：整体描述 + 每个可见元素的定位框（{fmt}，0–1000 归一化）。"
                                 f"detail={detail}。"},
        {"type": "image_url", "image_url": {"url": data_url}}]}]
    content = await _vision(messages, vision_model, 0.3)
    try:
        parsed = llm.extract_json(content)
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=502, detail=f"Layout 反推无法解析: {e}\n{content[:800]}") from e
    norm = normalize_reverse(parsed, img_w, img_h)
    if not norm["items"]:
        # 模型没按要求给坐标：退回旧格式（画布像素 bbox）
        legacy = _sanitize_layout_draft(parsed if isinstance(parsed, dict) else {}, w, h)
        norm["items"] = [{**{k: v for k, v in it.items() if k != "bbox"},
                          "box": [it["bbox"][0] / w, it["bbox"][1] / h, it["bbox"][2] / w, it["bbox"][3] / h]}
                         for it in legacy["items"]]
    draft = _sanitize_layout_draft(items_to_draft(norm, w, h), w, h)
    prompt, cerr = compile_safe(draft)
    out: dict[str, Any] = {
        "mode": "layout", "detail": detail, "box_format": fmt,
        "image": {"width": img_w, "height": img_h},
        "summary": norm["summary"], "items": norm["items"], "dropped": norm["dropped"],
        "draft": draft, "prompt": prompt, "raw": content[:4000],
    }
    if cerr:
        out["compile_error"] = cerr
    return out
