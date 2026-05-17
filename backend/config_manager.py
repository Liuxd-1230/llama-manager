"""Configuration management — load, save, scan models."""
from __future__ import annotations
import json
import os
from pathlib import Path
from typing import List
from .models import AppConfig, ModelInfo

CONFIG_DIR = Path.home() / "llama-manager" / "config"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)

_current_config: AppConfig = AppConfig()


def get_config() -> AppConfig:
    return _current_config


def save_config(config: AppConfig, name: str = "default") -> Path:
    global _current_config
    _current_config = config
    path = CONFIG_DIR / f"{name}.json"
    path.write_text(json.dumps(config.model_dump(), indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def load_config(name: str = "default") -> AppConfig:
    global _current_config
    path = CONFIG_DIR / f"{name}.json"
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        _current_config = AppConfig(**data)
    return _current_config


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
            entries.append({"name": item.name, "path": str(item), "is_dir": item.is_dir()})
    except PermissionError:
        pass
    return entries


def detect_server_binary(llama_cpp_dir: str) -> str:
    """Try to find llama-server binary in the llama.cpp directory."""
    d = Path(llama_cpp_dir)
    candidates = [
        d / "build" / "bin" / "llama-server",
        d / "build" / "bin" / "llama-server.exe",
        d / "llama-server",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return ""
