"""路径、设置与 JSON 读写。桌面打包（PyInstaller）与源码运行共用。"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

FROZEN = bool(getattr(sys, "frozen", False))
# 源码根目录（server/ 的上一级）
SRC_ROOT = Path(__file__).resolve().parent.parent
# 只读资源（dist / vendor）：打包后在 _MEIPASS 里
RES_ROOT = Path(getattr(sys, "_MEIPASS", SRC_ROOT))
# 可写数据：与 llama-manager 的用户目录约定保持一致
if os.environ.get("MOSS_DATA_DIR"):
    DATA = Path(os.environ["MOSS_DATA_DIR"]).expanduser().resolve()
else:
    DATA = Path.home() / "llama-manager" / "moss"
DATA.mkdir(parents=True, exist_ok=True)

SETTINGS_PATH = DATA / "settings.json"
SKILLS_PATH = DATA / "skills.json"
LEGACY_HISTORY_PATH = DATA / "history.json"
DB_PATH = DATA / "workspace.db"
ATTACH_DIR = DATA / "attachments"
DIST = RES_ROOT / "dist"
VENDOR = RES_ROOT / "moss_vendor"
SKILL_COMPILE = VENDOR / "moss-image-prompt-enhancer" / "scripts" / "compile_prompt.py"
CAPTION_PROMPT_PATH = VENDOR / "docs" / "CAPTION_PROMPT_ZH.md"

APP_VERSION = "2.4.0"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def save_json(path: Path, data: Any) -> None:
    """原子写入，避免写一半崩溃留下坏文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


SETTINGS_DEFAULTS: dict[str, Any] = {
    "provider_id": "deepseek",
    "model": "",
    "vision_model": "",  # 留空 = 跟随主模型
    # 主模型失败（网络 / 5xx / 429）时依次尝试，逗号分隔
    "fallback_models": "",
    "temperature": 0.7,
    # auto：先用原生 function calling，接口不支持时自动退回标签块协议
    "agent_protocol": "auto",
    # 每轮带给 Agent 的最近对话轮数，更早的压缩成摘要
    "context_turns": 10,
    "prompt_prefix": "best quality, masterpiece",
    "negative_prompt": "nsfw, worst quality, bad anatomy, watermark, jpeg artifact",
}


def load_settings() -> dict:
    stored = load_json(SETTINGS_PATH, {})
    if not isinstance(stored, dict):
        stored = {}
    out = {**SETTINGS_DEFAULTS, **stored}
    try:
        out["temperature"] = max(0.0, min(2.0, float(out.get("temperature", 0.7))))
    except (TypeError, ValueError):
        out["temperature"] = 0.7
    try:
        out["context_turns"] = max(2, min(40, int(out.get("context_turns", 10))))
    except (TypeError, ValueError):
        out["context_turns"] = 10
    if out.get("agent_protocol") not in ("auto", "tools", "tags"):
        out["agent_protocol"] = "auto"
    return out


def save_settings(s: dict) -> dict:
    keep = {k: s.get(k, v) for k, v in SETTINGS_DEFAULTS.items()}
    save_json(SETTINGS_PATH, keep)
    return load_settings()


def public_settings(s: dict) -> dict:
    from .. import provider_manager
    from .bridge import local_provider, resolve, ProviderError

    out = dict(s)
    # Legacy moss settings could carry a plaintext key; credentials now live
    # only in the shared provider store, so never echo them to the client.
    out.pop("api_key", None)
    out.pop("base_url", None)
    try:
        resolved = resolve(out.get("provider_id"))
        is_local = getattr(resolved["provider"], "kind", "") == "local"
        out["api_key_set"] = True if is_local else bool(resolved["api_key"])
        out["provider_name"] = resolved["provider"].name
    except ProviderError as exc:
        out["api_key_set"] = False
        out["provider_name"] = str(exc)
    out["providers"] = [vars(local_provider()), *provider_manager.list_providers()]
    return out


def model_chain(s: dict, primary: str | None = None) -> list[str]:
    from .bridge import model_chain as bridge_chain
    return bridge_chain(s.get("provider_id"), primary)


