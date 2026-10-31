"""数据模型：仓库文件、下载任务、应用设置。"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum


class FileCategory:
    """文件类型分类（用于筛选按钮与类型列显示）。"""

    GGUF = "GGUF"
    SAFETENSORS = "Safetensors"
    LITERT = "LiteRT"
    ZIP = "ZIP"
    CONFIG = "配置文件"
    OTHER = "其他"

    EXT_MAP = {
        GGUF: {".gguf"},
        SAFETENSORS: {".safetensors"},
        LITERT: {".litertlm", ".litert", ".tflite", ".task"},
        ZIP: {".zip"},
        CONFIG: {
            ".json", ".yaml", ".yml", ".txt", ".md", ".py", ".jinja",
            ".cfg", ".toml", ".model", ".merges", ".vocab", ".tiktoken",
            ".gitattributes", ".licen", "license",
        },
    }

    @classmethod
    def of(cls, path: str) -> str:
        name = path.rsplit("/", 1)[-1].lower()
        dot = name.rfind(".")
        ext = name[dot:] if dot >= 0 else name
        for cat, exts in cls.EXT_MAP.items():
            if ext in exts or (dot < 0 and name in exts):
                return cat
        return cls.OTHER


@dataclass
class RepoFile:
    """仓库中的一个文件。path 是含子目录的 POSIX 相对路径。"""

    path: str
    size: int | None = None          # LFS 文件为 LFS 大小，普通文件为 blob 大小
    is_lfs: bool = False
    oid: str | None = None           # git blob sha（非 LFS 时即 HF 的 etag）
    lfs_sha256: str | None = None    # LFS 内容 sha256（LFS 时即 HF 的 etag）

    @property
    def name(self) -> str:
        return self.path.rsplit("/", 1)[-1]

    @property
    def category(self) -> str:
        return FileCategory.of(self.path)


class TaskState(str, Enum):
    PENDING = "等待中"
    DOWNLOADING = "下载中"
    PAUSED = "已暂停"
    COMPLETED = "已完成"
    FAILED = "失败"
    CANCELLED = "已取消"


# 终态集合：不会再变化，除非用户手动重试
TERMINAL_STATES = {TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED}


@dataclass
class DownloadTask:
    """一个文件的下载任务，承载运行状态（线程安全：字段读写加锁）。"""

    repo_id: str
    revision: str
    filename: str                    # 含子目录
    size: int | None
    mode: str                        # "local_dir" | "cache"
    local_dir: str | None
    cache_dir: str | None
    endpoint: str
    batch_id: str

    task_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    state: TaskState = TaskState.PENDING
    bytes_done: int = 0
    error: str = ""                  # 中文友好错误
    error_kind: str = ""             # errors.py 的分类
    local_path: str = ""             # 完成后的实际文件路径（缓存模式为 snapshot 路径）
    attempts: int = 0
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    note: str = ""                   # 附加说明，如 "文件已存在"
    phase: str = "queued"
    range_supported: bool | None = None
    resumed_from: int = 0
    http_status: int | None = None
    worker_pid: int | None = None
    worker_guard: bool = False
    lfs_sha256: str | None = None    # LFS 内容 sha256（镜像头缺失降级下载时使用）
    git_oid: str | None = None       # git blob sha（同上，非 LFS 文件使用）

    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)
    stop_action: str = "cancel"     # cancel_event 置位时希望的动作："pause" | "cancel"
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _samples: list = field(default_factory=list, repr=False)   # [(t, cum_bytes)]
    _start_bytes: int = 0            # 续传起始字节，用于平均速度

    def begin_transfer(self, initial: int = 0, total: int | None = None):
        with self._lock:
            self.bytes_done = max(0,initial)
            self._start_bytes = self.bytes_done
            if total is not None: self.size = total
            self._samples = [(time.monotonic(),self.bytes_done)]
            self.phase = 'receiving'

    def note_bytes(self, n: int) -> None:
        """由下载线程调用：累计字节并记录速度样本。"""
        with self._lock:
            self.bytes_done += n
            now = time.monotonic()
            self._samples.append((now, self.bytes_done))
            if len(self._samples) > 128:
                del self._samples[:64]

    def set_state(self, state: TaskState, **kw) -> None:
        with self._lock:
            self.state = state
            if state is TaskState.DOWNLOADING and self.started_at is None:
                self.started_at = time.time()
            if state in TERMINAL_STATES or state is TaskState.PAUSED:
                self.finished_at = time.time()
            for k, v in kw.items():
                setattr(self, k, v)

    def snapshot(self) -> dict:
        """线程安全地取一份只读快照（供 UI 刷新）。"""
        with self._lock:
            speed = 0.0
            now = time.monotonic()
            samples = [s for s in self._samples if now - s[0] <= 5.0]
            if len(samples) >= 2 and now-samples[-1][0] < 2 and self.state is TaskState.DOWNLOADING and not self.cancel_event.is_set() and self.phase=='receiving':
                (t0, b0), (t1, b1) = samples[0], samples[-1]
                if t1 > t0:
                    speed = (b1 - b0) / (t1 - t0)
            if self.started_at is not None:
                wall = max((self.finished_at or time.time()) - self.started_at, 1e-6)
                avg = (self.bytes_done - self._start_bytes) / wall
            else:
                avg = 0.0
            return {
                "task_id": self.task_id,
                "repo_id": self.repo_id,
                "revision": self.revision,
                "filename": self.filename,
                "batch_id": self.batch_id,
                "state": self.state,
                "size": self.size,
                "bytes_done": self.bytes_done,
                "speed": speed,
                "avg_speed": avg,
                "error": self.error,
                "error_kind": self.error_kind,
                "local_path": self.local_path,
                "attempts": self.attempts,
                "note": self.note,
                "phase":self.phase,
                "range_supported":self.range_supported,
                "resumed_from":self.resumed_from,
                "http_status":self.http_status,
                "worker_pid":self.worker_pid,
                "worker_guard":self.worker_guard,
            }


@dataclass
class BatchSpec:
    """一次“开始下载”提交的整批任务。"""

    repo_id: str
    revision: str
    files: list[RepoFile]
    mode: str                        # "local_dir" | "cache"
    local_dir: str | None = None
    cache_dir: str | None = None
    endpoint: str = ""

    @property
    def total_size(self) -> int:
        return sum(f.size or 0 for f in self.files)


@dataclass
class AppSettings:
    """应用设置（持久化到 settings.json）。"""

    endpoint: str = "https://hf-mirror.net"
    download_mode: str = "local_dir"          # "local_dir" | "cache"
    local_dir: str = r"E:\LmModels"
    cache_dir: str = r"E:\huggingface_cache"
    max_workers: int = 4
    max_retries: int = 3
    theme: str = "dark"                        # "dark" | "light"
