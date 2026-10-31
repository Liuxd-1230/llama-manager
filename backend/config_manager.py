"""Configuration management — profiles, load, save, scan models."""
from __future__ import annotations
import json
import os
import re
import struct
import tempfile
import threading
from pathlib import Path
from typing import List
from .models import AppConfig, ModelInfo

from .paths import APP_DATA_DIR
CONFIG_DIR = APP_DATA_DIR / "config"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)

# Profile writes come from both threadpool (sync routes) and event-loop (async
# routes) contexts; one reentrant lock keeps read-modify-write sequences and
# the _current_config swap consistent.
_config_lock = threading.RLock()


def _atomic_write_text(path: Path, text: str) -> None:
    """Write through a unique temp file in the target directory, then replace.

    A fixed `.tmp` name let two concurrent saves interleave and hand
    os.replace a half-written file.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f"{path.name}.", suffix=".tmp")
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink(missing_ok=True)


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
        _atomic_write_text(_current_file(), _current_name)
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


def save_config(config: AppConfig, name: str = "default", *, make_current: bool = True) -> Path:
    global _current_config, _current_name
    safe_name = _sanitize_name(name)
    path = CONFIG_DIR / f"{safe_name}.json"
    with _config_lock:
        _atomic_write_text(path, json.dumps(config.model_dump(), indent=2, ensure_ascii=False))
        if make_current:
            _current_config = config
            _current_name = safe_name
            _persist_current()
    return path


def load_config(name: str = "default") -> AppConfig:
    global _current_config, _current_name
    name = _sanitize_name(name)
    path = CONFIG_DIR / f"{name}.json"
    with _config_lock:
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            _current_config = AppConfig(**data)
            _current_name = name
            _persist_current()
        return _current_config


def read_config(name: str) -> AppConfig | None:
    """Read a saved profile without switching the current config."""
    path = CONFIG_DIR / f"{_sanitize_name(name)}.json"
    with _config_lock:
        if not path.exists():
            return None
        return AppConfig(**json.loads(path.read_text(encoding="utf-8")))


def duplicate_config(source: str, new_name: str) -> Path:
    source = _sanitize_name(source)
    new_name = _sanitize_name(new_name)
    src = CONFIG_DIR / f"{source}.json"
    dst = CONFIG_DIR / f"{new_name}.json"
    with _config_lock:
        if not src.exists():
            raise FileNotFoundError(f"Profile not found: {source}")
        _atomic_write_text(dst, src.read_text(encoding="utf-8"))
    return dst


def list_configs() -> List[str]:
    return [p.stem for p in CONFIG_DIR.glob("*.json")]


def import_config(file_content: str) -> AppConfig:
    global _current_config
    with _config_lock:
        _current_config = AppConfig(**json.loads(file_content))
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
_ARRAY_ELEMENT_LIMIT = 1024  # head-count / layer-type arrays are small; skip giant ones


def read_gguf_metadata(model_path: str) -> dict:
    """Read a small whitelist of GGUF header fields (never tensor data).

    Metadata is display-only for profile cards and feeds the VRAM estimator
    (KV geometry), so any missing file or malformed header yields {} instead
    of an error.
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
                    values = []
                    for index in range(count):
                        item = read_string()
                        if index < _ARRAY_ELEMENT_LIMIT:
                            values.append(item)
                    return values
                fmt = _GGUF_SCALAR_FORMATS.get(elem_type)
                if fmt is None:
                    raise ValueError(f"unknown gguf array element type {elem_type}")
                values = []
                for index in range(count):
                    if index < _ARRAY_ELEMENT_LIMIT:
                        values.append(struct.unpack(fmt, fh.read(struct.calcsize(fmt)))[0])
                    else:
                        fh.seek(struct.calcsize(fmt), os.SEEK_CUR)
                return values
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
            elif key.endswith(".embedding_length"):
                meta["hidden"] = value
            elif key.endswith(".attention.head_count_kv"):
                meta["kv_heads"] = value
            elif key.endswith(".attention.head_count"):
                meta["heads"] = value
            elif key.endswith(".attention.key_length"):
                meta["head_dim"] = value
            elif key.endswith(".attention.layer_types"):
                meta["layer_types"] = value
            else:
                return False
            return True

        for index in range(kv_count):
            key = read_string()
            value_type, = struct.unpack("<I", fh.read(4))
            # Everything we want lives in the front matter, before the tokenizer
            # block. Those arrays hold hundreds of thousands of strings (248k
            # tokens + 247k merges for one 27B model), so reading them costs ~1M
            # syscalls per parse. Stop as soon as the geometry is complete, or
            # at the first tokenizer key once the basics are in hand — MoE
            # expert counts always precede the tokenizer section.
            if key.startswith("tokenizer.") and "layers" in meta and "kv_heads" in meta:
                break
            if record(key, read_value(value_type)):
                if ("name" in meta and "architecture" in meta and "layers" in meta
                        and "context_length" in meta and "kv_heads" in meta
                        and ("experts" in meta or index >= 32)):
                    break
    _finalize_gguf_meta(meta)
    return meta


def _finalize_gguf_meta(meta: dict) -> dict:
    """Derive per-token KV bytes (f16) from the header geometry.

    KV per token = 2 (K+V) × kv_heads × head_dim × 2 bytes, over the layers
    that actually carry attention. Hybrid architectures (linear attention /
    GDN layers) declare per-layer types or zero kv-head entries — count those;
    when the GGUF flattens a hybrid model to a scalar kv-head count, fall back
    to the known architecture stride (qwen3.5: full attention every 4th layer).
    """
    kv_heads = meta.get("kv_heads")
    if kv_heads is None:
        return meta
    layers = meta.get("layers")
    if isinstance(kv_heads, list):
        kv_layers = sum(1 for heads in kv_heads if heads)
        per_layer_heads = next((heads for heads in kv_heads if heads), 0)
        layer_types = meta.get("layer_types")
        if isinstance(layer_types, list) and layer_types:
            kv_layers = sum(1 for kind in layer_types if str(kind) == "full_attention")
    else:
        kv_layers = layers or 0
        per_layer_heads = kv_heads
        arch = str(meta.get("architecture", "")).lower()
        stride = next((v for key, v in {"qwen35": 4, "qwen3.5": 4}.items() if arch.startswith(key)), None)
        if stride and layers:
            kv_layers = -(-layers // stride)
    head_dim = meta.get("head_dim")
    if not head_dim:
        heads = meta.get("heads")
        hidden = meta.get("hidden")
        head_dim = int(hidden / heads) if heads and hidden else 128
    meta["head_dim"] = head_dim
    meta["kv_layers"] = kv_layers
    if kv_layers and per_layer_heads and head_dim:
        meta["kv_bytes_per_token_f16"] = 2 * int(per_layer_heads) * int(head_dim) * int(kv_layers) * 2
    if meta.get("experts") and layers:
        # MoE architectures put experts on every block; the estimator splits
        # GPU/RAM at --n-cpu-moe using this count.
        meta["moe_layers"] = layers
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
        if isinstance(config.get("hidden_size"), int):
            out["hidden"] = config["hidden_size"]
        if "mtp" in (manifest.get("components") or {}):
            out["native_mtp"] = True
        # Per-token KV estimate: the engine prints no per-token figure and the
        # manifest lacks attention geometry, so scale the pack-measured
        # 27.3 KB/token (bonsai2-27b, k8v4) by hidden size.
        layer_types = config.get("layer_types") or []
        if isinstance(layer_types, list) and layer_types:
            out["kv_layers"] = sum(1 for kind in layer_types if str(kind) == "full_attention")
        hidden = config.get("hidden_size")
        if isinstance(hidden, int) and hidden > 0:
            out["kv_bytes_per_token"] = int(27300 * hidden / 5120)
        return out
    except Exception:
        return {}


# Profile lists re-read model metadata on every refresh; header parses into
# multi-GB files dominate that latency, so cache by (mtime, size) stamp.
_META_CACHE: dict[str, tuple[tuple[float, int], dict]] = {}


def read_model_metadata(model_path: str) -> dict:
    """Dispatch by artifact type: .ninfer containers vs GGUF headers."""
    if not model_path:
        return {}
    path = Path(model_path)
    try:
        if not path.is_file():
            return {}
        stat = path.stat()
        stamp = (stat.st_mtime, stat.st_size)
        cached = _META_CACHE.get(str(path))
        if cached and cached[0] == stamp:
            return cached[1]
        if str(model_path).lower().endswith(".ninfer"):
            meta = read_ninfer_metadata(model_path)
        else:
            meta = read_gguf_metadata(model_path)
    except Exception:
        return {}
    _META_CACHE[str(path)] = (stamp, meta)
    return meta


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
    """Find the NInfer worker in an engine package dir.

    KVMem v0.18.0+ ships one unified worker at `workers/ninfer/
    ninfer-kvmem-server.exe`; the older standalone packs shipped
    `engine/ninfer-serve-<arch>.exe` (one binary per GPU arch, prefer sm_89).
    The glob cannot match the .old-<date> backups because they don't end in .exe.
    """
    d = Path(llama_cpp_dir)
    if not d.is_dir():
        return ""

    import sys
    suffix = ".exe" if sys.platform == "win32" else ""
    unified = f"ninfer-kvmem-server{suffix}"
    for base in (d, d / "workers" / "ninfer", d / "engine", d / "bin"):
        exact = base / unified
        if exact.exists():
            return str(exact)
    for pattern in ("ninfer-serve-89*", "ninfer-serve-*"):
        for base in (d, d / "engine", d / "bin"):
            for f in sorted(base.glob(pattern + suffix)):
                return str(f)
    for f in sorted(d.rglob("ninfer-serve-*" + suffix)):
        return str(f)
    return ""


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BUNDLED_ENGINE_ROOT = PROJECT_ROOT / "engine"


def bundled_package_dir() -> str:
    """Newest engine package extracted under <project root>/engine/."""
    if not BUNDLED_ENGINE_ROOT.is_dir():
        return ""
    best: tuple[tuple[int, ...], Path] | None = None
    for version_file in BUNDLED_ENGINE_ROOT.glob("*/VERSION"):
        raw = version_file.read_text(encoding="utf-8", errors="replace").strip()
        key = tuple(int(part) if part.isdigit() else 0 for part in re.split(r"[.\-+]", raw)[:3])
        if best is None or key > best[0]:
            best = (key, version_file.parent)
    return str(best[1]) if best else ""


def resolve_engine_dir(llama_cpp_dir: str, engine: str = "") -> str:
    """A profile left on the bundled release needs no directory of its own."""
    explicit = (llama_cpp_dir or "").strip()
    if explicit:
        return explicit
    return bundled_package_dir() if engine in ("kvmem", "ninfer") else ""


_FLAG_CACHE: dict[tuple[str, int, int], set[str]] = {}


def binary_flags(binary_path: str) -> set[str]:
    """Long flags a worker advertises in --help, cached per file revision.

    Launching a build that predates a flag kills the process on "unknown flag"
    with only a log line to show for it, so the command builders check first
    and raise something the user can act on.
    """
    path = Path(binary_path)
    if not path.is_file():
        return set()
    stat = path.stat()
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    cached = _FLAG_CACHE.get(key)
    if cached is not None:
        return cached

    import subprocess
    try:
        done = subprocess.run(
            [str(path), "--help"], capture_output=True, timeout=60, cwd=str(path.parent)
        )
    except (OSError, subprocess.SubprocessError):
        return set()
    text = (done.stdout + done.stderr).decode("utf-8", errors="replace")
    flags = set(re.findall(r"--[a-z][a-z0-9-]*", text))
    if len(_FLAG_CACHE) > 16:
        _FLAG_CACHE.clear()
    _FLAG_CACHE[key] = flags
    return flags


