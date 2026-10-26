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


def apply_bindings(nodes: dict, bindings: dict, values: dict) -> dict:
    """Return a copy of the workflow with each bound input replaced.

    bindings: field -> {node: "12", input: "text"}. Values that are None, empty
    strings or blank are skipped, so a half-filled form keeps the workflow's own
    defaults instead of wiping them. A binding whose node/input does not exist
    is skipped rather than inventing a field the node never reads.
    """
    out = copy.deepcopy(nodes)
    for field in FIELDS:
        binding = bindings.get(field) or {}
        node_id = str(binding.get("node") or "")
        input_name = str(binding.get("input") or "")
        if not node_id or not input_name or field not in values:
            continue
        value = values[field]
        if value is None or (isinstance(value, str) and not value.strip()):
            continue
        node = out.get(node_id)
        if not node:
            continue
        inputs = node.setdefault("inputs", {})
        if input_name not in inputs or is_link(inputs[input_name]):
            continue
        inputs[input_name] = value
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


def is_link(value: Any) -> bool:
    """API-format links are [node_id, output_slot] pairs."""
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and isinstance(value[1], int)


# Text inputs in preference order. SDXL/Flux dual-encoder nodes expose text_g /
# text_l instead of text, so a hardcoded "text" would invent a field the node
# never reads (the workflow would silently keep its own prompt).
TEXT_INPUTS = ("text", "text_g", "text_l", "prompt", "positive", "negative")


def text_input_of(node: dict) -> Optional[str]:
    inputs = node.get("inputs") or {}
    for name in TEXT_INPUTS:
        value = inputs.get(name)
        if name in inputs and not is_link(value):
            return name
    return None


def build_graph(nodes: dict, saved_layout: Optional[dict] = None) -> dict:
    """Derive a renderable graph: nodes, edges, and a layered left-to-right layout.

    API-format workflows carry no coordinates, so positions come from a
    longest-path layering (depth = 1 + max depth of inputs) with rows assigned in
    insertion order. A saved layout (node id -> {x, y}) wins, so dragging sticks.
    """
    layout = saved_layout or {}
    depth: dict[str, int] = {}

    def node_depth(node_id: str, seen: Optional[set] = None) -> int:
        if node_id in depth:
            return depth[node_id]
        seen = seen or set()
        if node_id in seen or node_id not in nodes:
            return 0
        seen.add(node_id)
        inputs = (nodes[node_id].get("inputs") or {}).values()
        parents = [str(value[0]) for value in inputs if is_link(value)]
        depth[node_id] = 1 + max((node_depth(p, seen) for p in parents), default=-1)
        return depth[node_id]

    columns: dict[int, list[str]] = {}
    for node_id in nodes:
        columns.setdefault(node_depth(node_id), []).append(node_id)

    graph_nodes = []
    for column, ids in sorted(columns.items()):
        for row, node_id in enumerate(ids):
            node = nodes[node_id]
            saved = layout.get(str(node_id)) or {}
            graph_nodes.append({
                "id": str(node_id),
                "title": node.get("_meta", {}).get("title") or node.get("class_type", ""),
                "class_type": node.get("class_type", ""),
                "position": {"x": saved.get("x", column * 260), "y": saved.get("y", row * 130)},
                "inputs": node_choices({str(node_id): node})[0]["inputs"],
            })

    edges = []
    for node_id, node in nodes.items():
        for input_name, value in (node.get("inputs") or {}).items():
            if is_link(value):
                edges.append({
                    "id": f"{value[0]}-{node_id}-{input_name}",
                    "source": str(value[0]),
                    "target": str(node_id),
                    "target_input": input_name,
                })
    return {"nodes": graph_nodes, "edges": edges}


async def fetch_choices(base: str) -> dict:
    """Real sampler/scheduler enums from ComfyUI, so the UI can offer dropdowns.

    /object_info is a large payload; only the sampler node's widget domains are
    extracted. ComfyUI versions differ, so every step degrades to an empty list.
    """
    out: dict[str, list[str]] = {"samplers": [], "schedulers": []}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{base}/object_info")
        if response.status_code >= 400:
            return out
        info = response.json() or {}
    except (httpx.RequestError, ValueError):
        return out

    def widget_domain(class_type: str, widget: str) -> list[str]:
        required = ((info.get(class_type) or {}).get("input") or {}).get("required") or {}
        spec = required.get(widget)
        if isinstance(spec, list) and spec and isinstance(spec[0], list):
            return [str(item) for item in spec[0]]
        return []

    out["samplers"] = widget_domain("KSampler", "sampler_name")
    out["schedulers"] = widget_domain("KSampler", "scheduler")
    return out


def node_choices(nodes: dict) -> list[dict]:
    """Flatten the workflow into candidate bindings for the UI.

    Literal values are included so the client can show what it is replacing;
    link inputs are flagged so they cannot be bound (a link is a wire, not a
    value).
    """
    out = []
    for node_id, node in nodes.items():
        inputs = node.get("inputs") or {}
        out.append({
            "node": str(node_id),
            "class_type": node.get("class_type", ""),
            "title": node.get("_meta", {}).get("title") or node.get("class_type", ""),
            "inputs": [
                {
                    "name": name,
                    "type": type(value).__name__,
                    "is_link": is_link(value),
                    "value": None if is_link(value) or isinstance(value, (dict, list)) else value,
                }
                for name, value in inputs.items()
            ],
        })
    return out


def validate_binding(nodes: dict, field: str, binding: dict) -> Optional[str]:
    """Return an error string when a binding cannot be applied, else None."""
    node_id = str(binding.get("node") or "")
    input_name = str(binding.get("input") or "")
    if not node_id or not input_name:
        return None  # unbound on purpose
    node = nodes.get(node_id)
    if not node:
        return f"{FIELD_LABELS.get(field, field)}：工作流里没有节点 {node_id}（可能换过工作流）"
    inputs = node.get("inputs") or {}
    if input_name not in inputs:
        return f"{FIELD_LABELS.get(field, field)}：节点 {node_id} 没有输入「{input_name}」"
    if is_link(inputs[input_name]):
        return f"{FIELD_LABELS.get(field, field)}：「{input_name}」是连线，不能填值"
    return None


def guess_bindings(nodes: dict) -> dict:
    """Best-effort bindings from the workflow's own wiring.

    Positive/negative resolve through the sampler's positive/negative links, and
    bind to whichever text input the target node actually has. The rest fall
    back to input-name matching on literal (non-link) inputs.
    """
    out: dict[str, dict] = {}

    def ref(node_id: str, input_name: str) -> Optional[str]:
        value = (nodes.get(node_id) or {}).get("inputs", {}).get(input_name)
        if is_link(value):
            return str(value[0])
        return None

    for node_id, node in nodes.items():
        for field in ("positive", "negative"):
            target = ref(node_id, field)
            if not target or field in out:
                continue
            text_input = text_input_of(nodes.get(target) or {})
            if text_input:
                out[field] = {"node": target, "input": text_input}

    name_map = {
        "text": "positive", "positive": "positive", "negative": "negative",
        "seed": "seed", "noise_seed": "seed", "width": "width", "height": "height",
        "cfg": "cfg", "sampler_name": "sampler", "scheduler": "scheduler", "steps": "steps",
    }
    for node_id, node in nodes.items():
        for input_name, value in (node.get("inputs") or {}).items():
            field = name_map.get(str(input_name).lower())
            if not field or field in out or is_link(value):
                continue
            if field == "negative" and out.get("positive", {}).get("node") == str(node_id):
                continue
            out[field] = {"node": str(node_id), "input": input_name}
    return out
