"""下载引擎（纯 Python，无 Qt 依赖）。

受管文件进程接收真实字节，256KB 分块、100ms 进度快照。暂停与取消先终止
对应文件进程并等待退出，再发布终态；Windows Job Object 约束父进程退出时
的子进程寿命。HTTP Range 断点绑定仓库版本与 ETag，并校验大小及内容摘要。
HF 1.33 不再跨进程复用随机临时文件，因此不依赖它的 HTTP 续传实现。
并发仅控制文件数，不盲目拆分单文件连接；认证与不存在错误不自动重试。
"""

from __future__ import annotations

import logging
import re
import threading
import time
import uuid
from typing import Callable

from ..models import BatchSpec, DownloadTask, TaskState
from .errors import (
    KIND_AUTH,
    KIND_NETWORK,
    RETRYABLE_KINDS,
    translate_exception,
)

logger = logging.getLogger(__name__)

_COMMIT_RE = re.compile(r"[0-9a-f]{40}")


class _TaskInterrupted(Exception):
    """tqdm 钩子内部抛出的协作式中断（暂停或取消）。"""

    def __init__(self, action: str):  # "pause" | "cancel"
        self.action = action


class DynamicSemaphore:
    """最大并发数可动态调整的信号量（条件变量实现）。"""

    def __init__(self, initial: int):
        self._cond = threading.Condition()
        self._max = max(1, initial)
        self._in_use = 0

    def set_max(self, value: int) -> None:
        value = max(1, value)
        with self._cond:
            self._max = value
            self._cond.notify_all()

    def acquire(self, cancel_event: threading.Event | None = None) -> bool:
        """获取许可。等待期间 cancel_event 置位则返回 False（调用方放弃）。"""
        with self._cond:
            while self._in_use >= self._max:
                if cancel_event is not None and cancel_event.is_set():
                    return False
                self._cond.wait(timeout=0.2)
            if cancel_event is not None and cancel_event.is_set(): return False
            self._in_use += 1
            return True

    def release(self) -> None:
        with self._cond:
            self._in_use = max(0,self._in_use-1)
            self._cond.notify_all()


class DownloadEngine:
    """管理一批批下载任务：并发调度、暂停/恢复/取消/重试、速度统计。"""

    def __init__(
        self,
        token_provider: Callable[[], str | None],
        history=None,
        max_workers: int = 4,
        max_retries: int = 3,
        retry_base_delay: float = 2.0,
    ):
        self._token_provider = token_provider
        self.history = history
        self._sem = DynamicSemaphore(max_workers)
        self._max_retries = max_retries
        self._retry_base_delay = retry_base_delay
        self._tasks: dict[str, DownloadTask] = {}
        self._order: list[str] = []
        self._threads: dict[str, threading.Thread] = {}
        self._lock = threading.RLock()

    # ---------- 对外 API ----------

    def set_max_workers(self, n: int) -> None:
        self._sem.set_max(n)

    def set_max_retries(self, n: int) -> None:
        self._max_retries = max(0, n)

    def submit(self, spec: BatchSpec) -> str:
        batch_id = uuid.uuid4().hex[:8]
        with self._lock:
            for f in spec.files:
                task = DownloadTask(
                    repo_id=spec.repo_id,
                    revision=spec.revision,
                    filename=f.path,
                    size=f.size,
                    mode=spec.mode,
                    local_dir=spec.local_dir,
                    cache_dir=spec.cache_dir,
                    endpoint=spec.endpoint,
                    batch_id=batch_id,
                    lfs_sha256=getattr(f, "lfs_sha256", None),
                    git_oid=getattr(f, "oid", None),
                )
                self._tasks[task.task_id] = task
                self._order.append(task.task_id)
                self._start_thread(task)
        logger.info(
            "提交下载批次 %s：%s@%s，%d 个文件，模式 %s",
            batch_id, spec.repo_id, spec.revision, len(spec.files), spec.mode,
        )
        return batch_id

    def pause(self, task_id: str) -> None:
        task = self._tasks.get(task_id)
        if task and task.state in (TaskState.DOWNLOADING, TaskState.PENDING):
            task.stop_action = "pause"
            task.cancel_event.set()
            task.set_state(task.state, note="正在结束传输，保留断点…")
            if not self._threads.get(task_id) or not self._threads[task_id].is_alive():
                task.set_state(TaskState.PAUSED,note='断点已保存')

    def resume(self, task_id: str) -> None:
        task = self._tasks.get(task_id)
        if task and task.state in (TaskState.PAUSED, TaskState.CANCELLED, TaskState.FAILED):
            self._reset_and_rerun(task)

    def cancel(self, task_id: str) -> None:
        task = self._tasks.get(task_id)
        if not task or task.state in (TaskState.COMPLETED, TaskState.CANCELLED):
            return
        task.stop_action = "cancel"
        task.cancel_event.set()
        if not self._threads.get(task_id) or not self._threads[task_id].is_alive():
            task.set_state(TaskState.CANCELLED,note='已取消，传输已停止')
        else: task.set_state(task.state,note='正在取消传输…')

    def retry(self, task_id: str) -> None:
        task = self._tasks.get(task_id)
        if task and task.state in (TaskState.FAILED, TaskState.CANCELLED, TaskState.PAUSED):
            self._reset_and_rerun(task)

    def pause_all(self) -> None:
        for tid in list(self._active_ids()):
            self.pause(tid)

    def resume_all(self) -> None:
        for tid in list(self._order):
            self.resume(tid)

    def cancel_all(self) -> None:
        for tid in list(self._order):
            self.cancel(tid)

    def shutdown(self) -> None:
        self.cancel_all()
        deadline=time.monotonic()+5
        for thread in list(self._threads.values()):
            thread.join(timeout=max(0,deadline-time.monotonic()))

    def retry_failed(self, batch_id: str | None = None) -> None:
        for tid in list(self._order):
            t = self._tasks.get(tid)
            if t and t.state is TaskState.FAILED and (batch_id is None or t.batch_id == batch_id):
                self.retry(tid)

    def snapshot(self) -> list[dict]:
        with self._lock:
            ids = list(self._order)
        out = []
        for tid in ids:
            t = self._tasks.get(tid)
            if t:
                out.append(t.snapshot())
        return out

    def batch_summary(self, batch_id: str) -> dict:
        tasks = [t for t in self._tasks.values() if t.batch_id == batch_id]
        total = sum(t.size or 0 for t in tasks)
        done = 0
        done_count = failed_count = active = 0
        for t in tasks:
            done += min(t.bytes_done, t.size or t.bytes_done)
            if t.state is TaskState.COMPLETED:
                done_count += 1
            elif t.state is TaskState.FAILED:
                failed_count += 1
            if t.state in (TaskState.DOWNLOADING, TaskState.PENDING):
                active += 1
        # 汇总速度：对各任务速度快照求和
        speed = sum(t.snapshot()["speed"] for t in tasks)
        remaining = max(total - done, 0)
        eta = remaining / speed if speed > 0 else None
        return {
            "batch_id": batch_id,
            "total": total,
            "done": done,
            "speed": speed,
            "eta": eta,
            "done_count": done_count,
            "failed_count": failed_count,
            "active": active,
            "count": len(tasks),
        }

    def all_tasks_finished(self, batch_id: str) -> bool:
        return all(
            t.state in (TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELLED)
            for t in self._tasks.values()
            if t.batch_id == batch_id
        )

    # ---------- 内部实现 ----------

    def _active_ids(self) -> list[str]:
        return [
            tid for tid, t in self._tasks.items()
            if t.state in (TaskState.DOWNLOADING, TaskState.PENDING)
        ]

    def _reset_and_rerun(self, task: DownloadTask) -> None:
        with self._lock:
            live = self._threads.get(task.task_id)
        # 旧线程可能还差最后一次清理才退出（例如正在抛出中断异常），
        # 最多等 3 秒；等不到就不重启，用户可再次点恢复。
        if live is not None and live.is_alive():
            live.join(timeout=3.0)
            if live.is_alive():
                raise RuntimeError('下载请求仍在退出，请稍后恢复')
        task.cancel_event.clear()
        task.set_state(TaskState.PENDING, error="", error_kind="", note="")
        self._start_thread(task)

    def _start_thread(self, task: DownloadTask) -> None:
        def run():
            if not self._sem.acquire(task.cancel_event):
                # 等待并发名额期间被取消（未持有许可，无需释放）
                if task.state not in (TaskState.PAUSED, TaskState.CANCELLED):
                    task.set_state(TaskState.PAUSED if task.stop_action=='pause' else TaskState.CANCELLED)
                return
            try:
                self._run_task(task)
            finally:
                self._sem.release()
                with self._lock:
                    self._threads.pop(task.task_id, None)

        th = threading.Thread(target=run, daemon=True, name=f"dl-{task.filename[:24]}")
        with self._lock:
            self._threads[task.task_id] = th
        th.start()

    def _run_task(self, task: DownloadTask) -> None:
        while True:
            task.attempts += 1
            try:
                if task.cancel_event.is_set(): raise _TaskInterrupted(task.stop_action)
                self._download_once(task)
                return
            except _TaskInterrupted as intr:
                if intr.action == "cancel":
                    task.set_state(TaskState.CANCELLED,note='已取消，传输已停止')
                else:
                    task.set_state(TaskState.PAUSED,note='断点已保存')
                self._record_history(task)
                return
            except Exception as exc:  # noqa: BLE001
                friendly = translate_exception(exc, task.endpoint)
                task.set_state(
                    TaskState.FAILED,
                    error=friendly.message,
                    error_kind=friendly.kind,
                )
                logger.error(
                    "下载失败 %s/%s [%s] 尝试 %d：%s",
                    task.repo_id, task.filename, friendly.kind, task.attempts, exc,
                    exc_info=friendly.kind not in (KIND_AUTH, KIND_NETWORK),
                )
                can_retry = (
                    friendly.kind in RETRYABLE_KINDS
                    and task.attempts <= self._max_retries
                    and not task.cancel_event.is_set()
                )
                if can_retry:
                    delay = min(self._retry_base_delay * (2 ** (task.attempts - 1)), 20.0)
                    logger.info("将在 %.1f 秒后重试（第 %d 次）：%s", delay, task.attempts, task.filename)
                    task.set_state(TaskState.PENDING, note=f"等待重试（{task.attempts}/{self._max_retries}）…")
                    if task.cancel_event.wait(delay):
                        if (task.stop_action or "cancel") == "pause":
                            task.set_state(TaskState.PAUSED)
                        else:
                            task.set_state(TaskState.CANCELLED)
                        self._record_history(task)
                        return
                    task.set_state(TaskState.DOWNLOADING, note="")
                    continue
                # 出错的同时用户请求了暂停 → 以暂停为准
                if task.cancel_event.is_set() and (task.stop_action or "cancel") == "pause":
                    task.set_state(TaskState.PAUSED)
                    return
                self._record_history(task)
                return

    def _download_once(self, task: DownloadTask) -> None:
        from .transfer_worker import controlled_transfer
        token=self._token_provider()
        controlled_transfer(task,token)
        self._record_history(task)

    def _transfer_once(self, task: DownloadTask) -> None:
        from .http_transfer import download_file
        path=download_file(task,self._token_provider(),self._repo_commit)
        task.set_state(TaskState.COMPLETED,local_path=path,phase='completed')

    def _repo_commit(self, task: DownloadTask, token: str | None) -> str | None:
        """查询仓库 revision 对应的 commit hash（带缓存）。"""
        with self._lock:
            cache = getattr(self, "_commit_cache", None)
            if cache is None:
                cache = self._commit_cache = {}
        key = (task.repo_id, task.revision, bool(token))
        if key in cache:
            return cache[key]
        from .hf_client import build_api

        info = build_api(task.endpoint, token).model_info(task.repo_id, revision=task.revision)
        commit = getattr(info, "sha", None)
        if commit:
            with self._lock:
                cache[key] = commit
        return commit

    def _record_history(self, task: DownloadTask) -> None:
        if self.history is None:
            return
        status = {
            TaskState.COMPLETED: "completed",
            TaskState.FAILED: "failed",
            TaskState.CANCELLED: "canceled",
            TaskState.PAUSED: "paused",
        }.get(task.state)
        if status is None:
            return
        self.history.add(
            repo_id=task.repo_id,
            revision=task.revision,
            filename=task.filename,
            size=task.size,
            local_path=task.local_path,
            mirror=task.endpoint,
            mode=task.mode,
            status=status,
            error=task.error,
        )
