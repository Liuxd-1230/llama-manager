"""Configuration management — profiles, load, save, scan models."""
from __future__ import annotations
import json
import os
import re
import struct
from pathlib import Path
from typing import List
from .models import AppConfig, ModelInfo

CONFIG_DIR = Path.home() / "llama-manager" / "config"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def _sanitize_name(name: str) -> str:
    """Strip path traversal and illegal chars from config name."""
    name = name.replace("..", "").replace("/", "").replace("\\", "").strip()
    name = re.sub(r'[^\w\-. ]', '', name)
    return name[:100] or "default"


_current_config: AppConfig = AppConfig()
_current_name: str = "default"


def get_config() -> AppConfig:
    return _current_config


def get_current_name() -> str:
    return _current_name


def save_config(config: AppConfig, name: str = "default") -> Path:
    global _current_config, _current_name
    _current_config = config
    _current_name = _sanitize_name(name)
    path = CONFIG_DIR / f"{_current_name}.json"
    path.write_text(json.dumps(config.model_dump(), indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def load_config(name: str = "default") -> AppConfig:
    global _current_config, _current_name
    name = _sanitize_name(name)
    path = CONFIG_DIR / f"{name}.json"
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        _current_config = AppConfig(**data)
        _current_name = name
    return _current_config


def read_config(name: str) -> AppConfig | None:
    """Read a saved profile without switching the current config."""
    path = CONFIG_DIR / f"{_sanitize_name(name)}.json"
    if not path.exists():
        return None
    return AppConfig(**json.loads(path.read_text(encoding="utf-8")))


def duplicate_config(source: str, new_name: str) -> Path:
    source = _sanitize_name(source)
    new_name = _sanitize_name(new_name)
    src = CONFIG_DIR / f"{source}.json"
    if not src.exists():
        raise FileNotFoundError(f"Profile not found: {source}")
    dst = CONFIG_DIR / f"{new_name}.json"
    dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    return dst


def list_configs() -> List[str]:
    return [p.stem for p in CONFIG_DIR.glob("*.json")]


def import_config(file_content: str) -> AppConfig:
    global _current_config
    data = json.loads(file_content)
    _current_config = AppConfig(**data)
    return _current_config


def scan_models(directory: str) -> List[ModelInfo]:
    """Recursively scan a directory for .gguf model files."""
    models = []
    d = Path(directory)
    if not d.is_dir():
        return models
    for f in sorted(d.rglob("*.gguf")):
        size_mb = f.stat().st_size / (1024 * 1024)
        models.append(ModelInfo(name=f.name, path=str(f), size_mb=round(size_mb, 1)))
    return models


# ── GGUF header metadata ──────────────────────────────────────

_GGUF_MAGIC = b"GGUF"
_GGUF_STRING = 8
_GGUF_ARRAY = 9
_GGUF_SCALAR_FORMATS = {
    0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i",
    6: "<f", 7: "<B", 10: "<Q", 11: "<q", 12: "<d",
}


def read_gguf_metadata(model_path: str) -> dict:
    """Read a small whitelist of GGUF header fields (never tensor data).

    Metadata is display-only for profile cards, so any missing file or
    malformed header yields {} instead of an error.
    """
    path = Path(model_path) if model_path else None
    if not path or not path.is_file():
        return {}
    try:
        return _parse_gguf_header(path)
    except Exception:
        return {}


def _parse_gguf_header(path: Path) -> dict:
    meta: dict = {}
    with path.open("rb") as fh:
        if fh.read(4) != _GGUF_MAGIC:
            return meta
        version, = struct.unpack("<I", fh.read(4))
        if version not in (2, 3):
            return meta
        fh.read(8)  # tensor_count — tensor info lives after metadata and is not needed
        kv_count, = struct.unpack("<Q", fh.read(8))

        def read_string() -> str:
            length, = struct.unpack("<Q", fh.read(8))
            return fh.read(length).decode("utf-8", errors="replace")

        def read_value(value_type: int):
            if value_type == _GGUF_STRING:
                return read_string()
            if value_type == _GGUF_ARRAY:
                elem_type, = struct.unpack("<I", fh.read(4))
                count, = struct.unpack("<Q", fh.read(8))
                if elem_type == _GGUF_STRING:
                    for _ in range(count):
                        read_string()
                else:
                    fmt = _GGUF_SCALAR_FORMATS.get(elem_type)
                    if fmt:
                        fh.seek(struct.calcsize(fmt) * count, os.SEEK_CUR)
                return None
            fmt = _GGUF_SCALAR_FORMATS.get(value_type)
            if fmt is None:
                raise ValueError(f"unknown gguf value type {value_type}")
            return struct.unpack(fmt, fh.read(struct.calcsize(fmt)))[0]

        def record(key: str, value) -> bool:
            if value is None:
                return False
            if key == "general.name":
                meta["name"] = value
            elif key == "general.architecture":
                meta["architecture"] = value
            elif key.endswith(".block_count"):
                meta["layers"] = value
            elif key.endswith(".expert_count"):
                meta["experts"] = value
            elif key.endswith(".expert_used_count"):
                meta["active_experts"] = value
            elif key.endswith(".context_length"):
                meta["context_length"] = value
            else:
                return False
            return True

        for index in range(kv_count):
            key = read_string()
            value_type, = struct.unpack("<I", fh.read(4))
            if record(key, read_value(value_type)):
                # All wanted keys sit in the front matter; expert keys only exist
                # for MoE models, so don't wait for them on dense ones.
                if ("name" in meta and "architecture" in meta and "layers" in meta
                        and "context_length" in meta and ("experts" in meta or index >= 64)):
                    break
    return meta


def list_drives() -> list[str]:
    """List available drive letters on Windows, or ['/'] on Linux."""
    import sys
    if sys.platform == "win32":
        import string
        drives = []
        for letter in string.ascii_uppercase:
            d = f"{letter}:\\"
            if Path(d).exists():
                drives.append(f"{letter}:")
        return drives
    return ["/"]


def browse_directory(directory: str) -> list[dict]:
    """List contents of a directory (files + dirs)."""
    from .models import DirEntry
    d = Path(directory)
    if not d.is_dir():
        return []
    entries = []
    try:
        for item in sorted(d.iterdir()):
            if item.name.startswith('.'):
                continue
            size_mb = 0
            if item.is_file():
                try:
                    size_mb = round(item.stat().st_size / (1024 * 1024), 1)
                except OSError:
                    pass
            entries.append({"name": item.name, "path": str(item), "is_dir": item.is_dir(), "size_mb": size_mb})
    except PermissionError:
        pass
    return entries


def detect_server_binary(llama_cpp_dir: str) -> str:
    """Try to find llama-server binary in the llama.cpp directory.
    Checks common paths first, then falls back to recursive search."""
    d = Path(llama_cpp_dir)
    if not d.is_dir():
        return ""

    import sys
    exe = "llama-server.exe" if sys.platform == "win32" else "llama-server"

    # 1. Common fixed paths (fast) — Windows MSVC uses Release/Debug subdirs
    candidates = [
        d / "build" / "bin" / exe,
        d / "build" / "bin" / "Release" / exe,
        d / "build" / "bin" / "Debug" / exe,
        d / exe,
    ]
    for c in candidates:
        if c.exists():
            return str(c)

    # 2. Recursive search (slower but thorough)
    for f in d.rglob(exe):
        return str(f)

    return ""
