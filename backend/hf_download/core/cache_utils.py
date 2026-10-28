"""缓存目录解析、等价 hf 命令预览、未完成临时文件清理。

HF 缓存结构（官方约定，位于 HF_HUB_CACHE 下）：
  models--{org}--{repo}/
    blobs/<sha256>            # 实际存储的内容
    refs/<revision>           # revision → commit hash
    snapshots/<commit>/<path> # 指向 blobs 的符号链接（无权限时为副本）

用户拿到手的“真正文件”在 snapshots/<commit>/ 下，下载完成后
hf_hub_download 的返回值就是该路径，程序直接展示给用户。
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def resolve_hub_cache_dir(setting_value: str) -> str:
    """把用户设置的缓存目录解析为实际的 HF_HUB_CACHE。

    兼容两种习惯：
      - HF_HUB_CACHE 风格：models--* 直接在该目录下 → 原样使用
      - HF_HOME 风格：models--* 在 <目录>/hub 下 → 使用 <目录>/hub
    全新目录按 HF_HUB_CACHE 风格原样使用。
    """
    base = Path(setting_value).expanduser()
    try:
        hub = base / "hub"
        if hub.is_dir() and any(hub.glob("models--*")):
            return str(hub)
        if any(base.glob("models--*")):
            return str(base)
    except OSError:
        pass
    return str(base)


def find_incomplete_files(cache_dir: str | None = None, local_dirs: list[str] | None = None) -> list[Path]:
    """查找所有未完成的 .incomplete 临时文件（供“清理临时文件”功能）。"""
    found: list[Path] = []
    roots: list[Path] = []
    if cache_dir:
        roots.append(Path(resolve_hub_cache_dir(cache_dir)))
    for d in local_dirs or []:
        p = Path(d)
        if p.is_dir():
            roots.append(p / ".cache")
    for root in roots:
        try:
            if root.is_dir():
                found.extend(root.rglob("*.incomplete"))
        except OSError as exc:
            logger.warning("扫描临时文件失败 %s: %s", root, exc)
    return found


def incomplete_total_size(files: list[Path]) -> int:
    total = 0
    for f in files:
        try:
            total += f.stat().st_size
        except OSError:
            pass
    return total


def build_hf_command(
    repo_id: str,
    revision: str = "main",
    patterns: list[str] | None = None,
    mode: str = "local_dir",
    local_dir: str | None = None,
    cache_dir: str | None = None,
) -> str:
    """生成等价的 `hf download` 命令（huggingface_hub >= 0.34 的官方 CLI）。"""
    parts = ["hf", "download", repo_id]
    if revision and revision != "main":
        parts += ["--revision", revision]
    if patterns:
        quoted = " ".join(f'"{p}"' for p in patterns)
        parts += ["--include", quoted]
    if mode == "local_dir":
        parts += ["--local-dir", f'"{local_dir}"']
    else:
        parts += ["--cache-dir", f'"{cache_dir}"']
    return " ".join(parts)
