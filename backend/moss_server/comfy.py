"""ComfyUI bridge: workflow import, placeholder binding, submission and polling.

The user imports a workflow JSON (API format: node_id -> {class_type, inputs})
and binds each field to a node input. We substitute values at submit time and
talk to ComfyUI's HTTP API (/prompt, /history, /view).
"""

from __future__ import annotations

import copy
import json
import time
import uuid
from typing import Any, Optional

import httpx

COMFY_DEFAULT = "http://127.0.0.1:8188"

# Fields the binding UI exposes. "width"/"height" also drive the studio canvas.
FIELDS = (
    "positive", "negative", "seed", "width", "height",
    "cfg", "sampler", "scheduler", "steps",
)

FIELD_LABELS = {
    "positive": "正向提示词",
    "negative": "负向提示词",
    "seed": "种子 (seed)",
    "width": "宽度 (width)",
    "height": "高度 (height)",
    "cfg": "CFG",
    "sampler": "采样器 (sampler_name)",
    "scheduler": "调度器 (scheduler)",
    "steps": "步数 (steps)",
}


class ComfyError(RuntimeError):
    pass


def comfy_base(settings: dict) -> str:
    return (settings.get("comfy_url") or COMFY_DEFAULT).rstrip("/")


def parse_workflow(raw: str | dict) -> dict:
    """Accept API-format workflows; reject the UI-export shape with a clear hint."""
    data = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(data, dict):
        raise ComfyError("workflow 必须是 JSON 对象")
    if "nodes" in data and "links" in data:
        raise ComfyError("这是 ComfyUI 的界面导出格式。请在 ComfyUI 里用「保存 (API Format)」导出 API 格式的 workflow。")
    nodes = {key: value for key, value in data.items() if isinstance(value, dict) and "class_type" in value}
    if not nodes:
        raise ComfyError("workflow 里没有可识别的节点（需要 API 格式：节点 id → class_type/inputs）")
    return nodes


def _set_path(inputs: dict, name: str, value: Any) -> None:
    inputs[name] = value


def apply_bindings(nodes: dict, bindings: dict, values: dict) -> dict:
    """Return a copy of the workflow with each bound input replaced.

    bindings: field -> {node: "12", input: "text"}. Missing values leave the
    original workflow value untouched (so a partial binding still runs).
    """
    out = copy.deepcopy(nodes)
    for field in FIELDS:
        binding = bindings.get(field) or {}
        node_id = str(binding.get("node") or "")
        input_name = str(binding.get("input") or "")
        if not node_id or not input_name or field not in values:
            continue
        node = out.get(node_id)
        if not node:
            continue
        node.setdefault("inputs", {})
        _set_path(node["inputs"], input_name, values[field])
    return out


async def submit(base: str, workflow: dict, client_id: Optional[str] = None) -> str:
    prompt_id = str(uuid.uuid4())
    payload = {"prompt": workflow, "client_id": client_id or prompt_id}
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(f"{base}/prompt", json=payload)
    except httpx.RequestError as exc:
        raise ComfyError(f"连不上 ComfyUI（{base}）：{exc}") from exc
    if response.status_code >= 400:
        raise ComfyError(f"ComfyUI 拒绝了 workflow（{response.status_code}）：{response.text[:400]}")
    data = response.json()
    if data.get("error"):
        raise ComfyError(f"ComfyUI 报错：{json.dumps(data['error'], ensure_ascii=False)[:400]}")
    return str(data.get("prompt_id") or prompt_id)


async def wait_for_images(base: str, prompt_id: str, timeout: float = 300.0) -> list[dict]:
    """Poll /history until the prompt finishes; return [{filename, subfolder, type}]."""
    deadline = time.monotonic() + timeout
    async with httpx.AsyncClient(timeout=20.0) as client:
        while time.monotonic() < deadline:
            try:
                response = await client.get(f"{base}/history/{prompt_id}")
                if response.status_code == 200:
                    history = response.json() or {}
                    entry = history.get(prompt_id)
                    if entry:
                        status = (entry.get("status") or {})
                        if status.get("status_str") == "error":
                            raise ComfyError("ComfyUI 执行失败：" + json.dumps(status, ensure_ascii=False)[:400])
                        images: list[dict] = []
                        for node_output in (entry.get("outputs") or {}).values():
                            for image in node_output.get("images") or []:
                                images.append({
                                    "filename": image.get("filename", ""),
                                    "subfolder": image.get("subfolder", ""),
                                    "type": image.get("type", "output"),
                                })
                        if images:
                            return images
                        if status.get("completed") or status.get("status_str") == "success":
                            return []
            except httpx.RequestError:
                pass
            time.sleep(0.8)
    raise ComfyError("等待 ComfyUI 出图超时")


async def fetch_image(base: str, image: dict) -> tuple[bytes, str]:
    params = {"filename": image["filename"], "subfolder": image.get("subfolder", ""), "type": image.get("type", "output")}
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.get(f"{base}/view", params=params)
    if response.status_code >= 400:
        raise ComfyError(f"取图失败（{response.status_code}）")
    return response.content, image["filename"]


def node_choices(nodes: dict) -> list[dict]:
    """Flatten the workflow into candidate bindings for the UI."""
    out = []
    for node_id, node in nodes.items():
        inputs = node.get("inputs") or {}
        out.append({
            "node": str(node_id),
            "class_type": node.get("class_type", ""),
            "title": node.get("_meta", {}).get("title") or node.get("class_type", ""),
            "inputs": [{"name": name, "type": type(value).__name__} for name, value in inputs.items()],
        })
    return out

def guess_bindings(nodes: dict) -> dict:
    """Best-effort bindings from the workflow's own wiring.

    Positive/negative come from whichever CLIPTextEncode feeds a sampler's
    `positive`/`negative` input (both nodes are usually named just "text", so
    name matching alone would bind both to the same node). The rest fall back
    to input-name matching.
    """
    out: dict[str, dict] = {}

    def ref(node_id: str, input_name: str) -> Optional[str]:
        value = (nodes.get(node_id) or {}).get("inputs", {}).get(input_name)
        if isinstance(value, list) and value:
            return str(value[0])
        return None

    for node_id, node in nodes.items():
        inputs = node.get("inputs") or {}
        for field in ("positive", "negative"):
            target = ref(node_id, field)
            if target and field not in out:
                out[field] = {"node": target, "input": "text"}

    name_map = {
        "text": "positive", "positive": "positive", "negative": "negative",
        "seed": "seed", "noise_seed": "seed", "width": "width", "height": "height",
        "cfg": "cfg", "sampler_name": "sampler", "scheduler": "scheduler", "steps": "steps",
    }
    for node_id, node in nodes.items():
        for input_name in (node.get("inputs") or {}):
            field = name_map.get(str(input_name).lower())
            if not field or field in out:
                continue
            if field == "negative" and out.get("positive", {}).get("node") == str(node_id):
                continue
            out[field] = {"node": str(node_id), "input": input_name}
    return out
