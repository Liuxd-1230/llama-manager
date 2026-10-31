"""llama-server process management with real-time log streaming."""
from __future__ import annotations
import asyncio
import subprocess
import time
from collections import deque
from pathlib import Path
from typing import Optional, List, Any
from .models import AppConfig, ServerStatus
from . import config_manager as cfg
from .engine_commands import EngineCommandBuilder, IS_WINDOWS

ENGINE_IMAGE_NAMES = ("llama-server", "llama-kvmem-server", "ninfer-kvmem-server", "ninfer-serve")

def _exit_error(returncode: int) -> str:
    if returncode & 0xFFFFFFFF == 0xC0000135:
        return '引擎启动失败：找不到所需 DLL 运行库，请检查引擎目录和 CUDA 依赖（0xC0000135）。'
    return f'Exit code: {returncode}'



def engine_pid_file() -> Path:
    """Records the managed engine PID so a backend restart can reap the
    orphaned engine process it left behind."""
    from .config_manager import CONFIG_DIR
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    return CONFIG_DIR / ".engine-pid"


def record_engine_pid(pid: int) -> None:
    try:
        engine_pid_file().write_text(str(pid), encoding="utf-8")
    except OSError:
        pass


def forget_engine_pid(pid: int) -> None:
    try:
        if engine_pid_file().exists():
            engine_pid_file().unlink()
    except OSError:
        pass


def reap_orphan_engines() -> list[int]:
    """Kill engine processes left over from a previous backend run.

    The backend loses all process memory on restart, so an engine that was
    running would otherwise hold VRAM forever with no way to stop it from
    the UI. PIDs are verified against the engine image names before the kill.
    """
    path = engine_pid_file()
    if not path.exists():
        return []
    killed: list[int] = []
    for token in path.read_text(encoding="utf-8").split():
        if not token.isdigit():
            continue
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {token}"],
            capture_output=True,
        ).stdout.decode("utf-8", errors="replace").lower()
        if not any(name in out for name in ENGINE_IMAGE_NAMES):
            continue
        subprocess.run(["taskkill", "/F", "/PID", token], capture_output=True)
        killed.append(int(token))
    try:
        path.unlink()
    except OSError:
        pass
    return killed


class ProcessManager(EngineCommandBuilder):
    def __init__(self):
        self._process: Optional[asyncio.subprocess.Process] = None
        self._start_time: float = 0
        self._max_log_lines: int = 5000
        # deque auto-trims: slicing a list per log line is O(n) per line.
        self._log_buffer = deque(maxlen=self._max_log_lines)
        self._log_subscribers: List[Any] = []  # WebSocket connections
        self._profile_name: str = ""
        # Serializes start/stop: both check self._process before awaiting, so
        # two concurrent calls could otherwise spawn or kill twice.
        self._lock = asyncio.Lock()
        # Strong reference keeps the log reader alive until it drains stdout.
        self._reader_task: Optional[asyncio.Task] = None

    def get_status(self) -> ServerStatus:
        if self._process and self._process.returncode is None:
            return ServerStatus(
                state="running",
                pid=self._process.pid,
                uptime_seconds=round(time.time() - self._start_time, 1),
                profile=self._profile_name,
            )
        elif self._process and self._process.returncode is not None:
            return ServerStatus(
                state="stopped",
                error=_exit_error(self._process.returncode),
                profile=self._profile_name,
            )
        return ServerStatus(state="stopped")

    def _engine_dir(self, config: AppConfig) -> str:
        """Engine directory to search — an unset one means the bundled package."""
        return cfg.resolve_engine_dir(config.llama_cpp_dir, config.engine)

    async def start(self, config: AppConfig, profile_name: str = ""):
        # build_command probes the engine binary with --help (cached per file
        # revision) and resolve_engine_dir stats the disk: keep both off the
        # event loop and outside the lock so a slow first probe cannot stall
        # other requests or block a pending stop.
        cmd, engine_dir = await asyncio.to_thread(
            lambda: (self.build_command(config), self._engine_dir(config))
        )
        async with self._lock:
            if self._process and self._process.returncode is None:
                raise RuntimeError("Server is already running. Stop it first.")

            self._profile_name = profile_name
            self._log_buffer.clear()
            self._append_log(f"[manager] Starting: {' '.join(cmd)}")

            self._process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=engine_dir or None,
            )
            self._start_time = time.time()
            record_engine_pid(self._process.pid)
            self._append_log(f"[manager] Process started, PID={self._process.pid}")

            # Start log reader task
            self._reader_task = asyncio.create_task(self._read_output(self._process))

    async def _read_output(self, process: asyncio.subprocess.Process):
        # Bind to the process passed in: start() may replace self._process while
        # a previous reader is still draining, and the old reader must keep
        # reading the old process instead of stealing the new one's output.
        if process.stdout is None:
            return
        try:
            async for line in process.stdout:
                text = line.decode("utf-8", errors="replace").rstrip()
                self._append_log(text)
        except Exception as e:
            self._append_log(f"[manager] Log reader error: {e}")
        finally:
            # Settle the exit status: on Windows, returncode stays None until
            # wait() runs, which would leave a crashed server looking alive.
            try:
                if process.returncode is None:
                    await process.wait()
            except ProcessLookupError:
                pass
            if process.returncode not in (None, 0):
                self._append_log(f'[manager] {_exit_error(process.returncode)}')

    def _append_log(self, text: str):
        self._log_buffer.append(text)
        # Notify subscribers
        for sub in list(self._log_subscribers):
            try:
                sub.put_nowait(text)
            except asyncio.QueueFull:
                # A stalled WebSocket client must not grow memory without
                # bound; drop its oldest line and keep the newest flowing.
                try:
                    sub.get_nowait()
                    sub.put_nowait(text)
                except Exception:
                    try:
                        self._log_subscribers.remove(sub)
                    except ValueError:
                        pass
            except Exception:
                try:
                    self._log_subscribers.remove(sub)
                except ValueError:
                    pass

    async def stop(self):
        async with self._lock:
            process = self._process
            if not process or process.returncode is not None:
                self._append_log("[manager] No running process to stop.")
                return

            pid = process.pid
            self._append_log(f"[manager] Stopping PID={pid}...")
            try:
                if IS_WINDOWS:
                    # Windows: use taskkill to kill process tree
                    kill_proc = await asyncio.create_subprocess_exec(
                        "taskkill", "/F", "/T", "/PID", str(pid),
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.DEVNULL,
                    )
                    await kill_proc.wait()
                    self._append_log(f"[manager] Process {pid} killed via taskkill.")
                else:
                    process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), timeout=10)
                        self._append_log(f"[manager] Process {pid} exited gracefully.")
                    except asyncio.TimeoutError:
                        self._append_log("[manager] Terminate timeout, killing...")
                        process.kill()
                        await process.wait()
                        self._append_log(f"[manager] Process {pid} killed.")
            except ProcessLookupError:
                self._append_log(f"[manager] Process {pid} already exited.")
            finally:
                # Reap the killed process so a subsequent start() does not race on returncode.
                try:
                    if process.returncode is None:
                        await process.wait()
                except ProcessLookupError:
                    pass
                forget_engine_pid(pid)
                self._profile_name = ""

    def clear_logs(self):
        self._log_buffer.clear()
        self._append_log("[manager] Logs cleared.")

    def get_logs(self) -> List[str]:
        return list(self._log_buffer)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._log_subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self._log_subscribers:
            self._log_subscribers.remove(q)


# Singleton
process_manager = ProcessManager()
