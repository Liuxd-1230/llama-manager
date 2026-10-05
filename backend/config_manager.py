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


def _current_file() -> Path:
    """Where the last-used profile name persists across restarts."""
    return CONFIG_DIR / ".current"


def _persist_current() -> None:
    try:
        _current_file().write_text(_current_name, encoding="utf-8")
    except OSError:
        pass


def initial_profile_name() -> str:
    """Profile to load at startup: the last used one, falling back to default."""
    try:
        name = _current_file().read_text(encoding="utf-8").strip()
    except OSError:
        return "default"
    if name and (CONFIG_DIR / f"{_sanitize_name(name)}.json").exists():
        return name
    return "default"


def save_config(config: AppConfig, name: str = "default") -> Path:
    global _current_config, _current_name
    _current_config = config
    _current_name = _sanitize_name(name)
    path = CONFIG_DIR / f"{_current_name}.json"
    path.write_text(json.dumps(config.model_dump(), indent=2, ensure_ascii=False), encoding="utf-8")
    _persist_current()
    return path


def load_config(name: str = "default") -> AppConfig:
    global _current_config, _current_name
    name = _sanitize_name(name)
    path = CONFIG_DIR / f"{name}.json"
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        _current_config = AppConfig(**data)
        _current_name = name
        _persist_current()
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
    """Recursively scan a directory for .gguf and .ninfer model files."""
    models = []
    d = Path(directory)
    if not d.is_dir():
        return models
    files = sorted([*d.rglob("*.gguf"), *d.rglob("*.ninfer")], key=lambda f: str(f).lower())
    for f in files:
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


# ── .ninfer container metadata ────────────────────────────────
# Container: [0..6] magic "NINFER\0", [7] version, [8..15] manifest length
# uint64 LE, [16..31] artifact id, then the JSON manifest (peek_container.py).
_NINFER_MAGIC = b"NINFER\x00"


def read_ninfer_metadata(model_path: str) -> dict:
    """Read a .ninfer container's manifest header — display-only, no payload.

    Any missing file or malformed header yields {} instead of an error."""
    path = Path(model_path) if model_path else None
    if not path or not path.is_file():
        return {}
    try:
        with path.open("rb") as fh:
            head = fh.read(32)
            if len(head) < 32 or head[:7] != _NINFER_MAGIC:
                return {}
            (mlen,) = struct.unpack("<Q", head[8:16])
            manifest = json.loads(fh.read(mlen).decode("utf-8"))
        meta = manifest.get("metadata") or {}
        config = (manifest.get("components") or {}).get("text") or {}
        config = config.get("config") or {}
        out: dict = {}
        if meta.get("name"):
            out["name"] = meta["name"]
        architectures = config.get("architectures") or []
        if architectures:
            # "Qwen3_5ForCausalLM" → "Qwen3.5" for the card line
            out["architecture"] = str(architectures[0]).replace("ForCausalLM", "").replace("_", ".")
        if isinstance(config.get("num_hidden_layers"), int):
            out["layers"] = config["num_hidden_layers"]
        if isinstance(config.get("max_position_embeddings"), int):
            out["context_length"] = config["max_position_embeddings"]
        if "mtp" in (manifest.get("components") or {}):
            out["native_mtp"] = True
        return out
    except Exception:
        return {}


def read_model_metadata(model_path: str) -> dict:
    """Dispatch by artifact type: .ninfer containers vs GGUF headers."""
    if model_path and str(model_path).lower().endswith(".ninfer"):
        return read_ninfer_metadata(model_path)
    return read_gguf_metadata(model_path)


def list_drives() -> list[str]:
    """List available drive roots on Windows, or ['/'] on Linux.

    "D:" alone resolves to the current working directory of drive D — only
    "D:\\" addresses the drive root.
    """
    import sys
    if sys.platform == "win32":
        import string
        drives = []
        for letter in string.ascii_uppercase:
            d = f"{letter}:\\"
            if Path(d).exists():
                drives.append(d)
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


def detect_kvmem_binary(llama_cpp_dir: str) -> str:
    """Find llama-kvmem-server in a KVMem package dir (root or bin/)."""
    d = Path(llama_cpp_dir)
    if not d.is_dir():
        return ""

    import sys
    exe = "llama-kvmem-server.exe" if sys.platform == "win32" else "llama-kvmem-server"
    for c in (d / exe, d / "bin" / exe):
        if c.exists():
            return str(c)
    for f in d.rglob(exe):
        return str(f)
    return ""


def detect_ninfer_binary(llama_cpp_dir: str) -> str:
    """Find ninfer-serve-<arch>.exe in a NInfer pack dir.

    Packs ship engine\\ninfer-serve-<arch>.exe (one binary per GPU arch);
    prefer the sm_89 build, fall back to any arch that is present. The
    glob cannot match the .old-<date> backups because they don't end in .exe.
    """
    d = Path(llama_cpp_dir)
    if not d.is_dir():
        return ""

    import sys
    suffix = ".exe" if sys.platform == "win32" else ""
    for base in (d, d / "engine", d / "bin"):
        exact = base / f"ninfer-serve-89{suffix}"
        if exact.exists():
            return str(exact)
    for pattern in ("ninfer-serve-89*", "ninfer-serve-*"):
        for base in (d, d / "engine", d / "bin"):
            for f in sorted(base.glob(pattern + suffix)):
                return str(f)
    for f in sorted(d.rglob("ninfer-serve-*" + suffix)):
        return str(f)
    return ""
