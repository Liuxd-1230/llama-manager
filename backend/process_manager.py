"""llama-server process management with real-time log streaming."""
from __future__ import annotations
import asyncio
import time
import signal
import os
from typing import Optional, List, Callable, Any
from .models import AppConfig, ServerStatus
from .config_manager import detect_server_binary


class ProcessManager:
    def __init__(self):
        self._process: Optional[asyncio.subprocess.Process] = None
        self._start_time: float = 0
        self._log_buffer: List[str] = []
        self._log_subscribers: List[Any] = []  # WebSocket connections
        self._max_log_lines: int = 5000

    def get_status(self) -> ServerStatus:
        if self._process and self._process.returncode is None:
            return ServerStatus(
                state="running",
                pid=self._process.pid,
                uptime_seconds=round(time.time() - self._start_time, 1),
            )
        elif self._process and self._process.returncode is not None:
            return ServerStatus(
                state="stopped",
                error=f"Exit code: {self._process.returncode}",
            )
        return ServerStatus(state="stopped")

    def build_command(self, config: AppConfig) -> list[str]:
        """Build the llama-server command line from config."""
        server_bin = detect_server_binary(config.llama_cpp_dir)
        if not server_bin:
            raise FileNotFoundError(
                f"llama-server not found in {config.llama_cpp_dir}/build/bin/"
            )

        cmd = [server_bin]
        cmd += ["-m", config.model_path]

        if config.mmproj_path:
            cmd += ["--mmproj", config.mmproj_path]

        b = config.basic
        cmd += ["-c", str(b.ctx_size)]
        cmd += ["-ngl", str(b.ngl)]
        cmd += ["-t", str(b.threads)]
        cmd += ["-np", str(b.parallel)]

        if b.mmap:
            cmd.append("--mmap")
        else:
            cmd.append("--no-mmap")

        if b.moe_cpu_offload:
            cmd += ["--moe-expert-override", "cpu"]

        if b.kv_cache_quant:
            cmd += ["--cache-type-k", f"q{b.kv_cache_quant}",
                    "--cache-type-v", f"q{b.kv_cache_quant}"]

        if b.enable_thinking:
            cmd.append("--enable-thinking")

        s = config.sampling
        cmd += ["--temp", str(s.temperature)]
        cmd += ["--top-k", str(s.top_k)]
        cmd += ["--top-p", str(s.top_p)]

        if s.min_p_enabled:
            cmd += ["--min-p", str(s.min_p)]
        if s.repeat_penalty_enabled:
            cmd += ["--repeat-penalty", str(s.repeat_penalty)]
        if s.presence_penalty_enabled:
            cmd += ["--presence-penalty", str(s.presence_penalty)]

        if config.system_prompt:
            cmd += ["--system-prompt", config.system_prompt]

        srv = config.server
        cmd += ["--host", srv.host, "--port", str(srv.port)]

        if config.extra_params.strip():
            cmd += config.extra_params.strip().split()

        return cmd

    async def start(self, config: AppConfig):
        if self._process and self._process.returncode is None:
            raise RuntimeError("Server is already running. Stop it first.")

        cmd = self.build_command(config)
        self._log_buffer.clear()
        self._append_log(f"[manager] Starting: {' '.join(cmd)}")

        self._process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=config.llama_cpp_dir or None,
        )
        self._start_time = time.time()
        self._append_log(f"[manager] Process started, PID={self._process.pid}")

        # Start log reader task
        asyncio.create_task(self._read_output())

    async def _read_output(self):
        if not self._process or not self._process.stdout:
            return
        try:
            async for line in self._process.stdout:
                text = line.decode("utf-8", errors="replace").rstrip()
                self._append_log(text)
        except Exception as e:
            self._append_log(f"[manager] Log reader error: {e}")

    def _append_log(self, text: str):
        self._log_buffer.append(text)
        if len(self._log_buffer) > self._max_log_lines:
            self._log_buffer = self._log_buffer[-self._max_log_lines:]
        # Notify subscribers
        for sub in list(self._log_subscribers):
            try:
                sub.put_nowait(text)
            except Exception:
                self._log_subscribers.remove(sub)

    async def stop(self):
        if not self._process or self._process.returncode is not None:
            self._append_log("[manager] No running process to stop.")
            return

        pid = self._process.pid
        self._append_log(f"[manager] Sending SIGTERM to PID={pid}...")
        try:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=10)
                self._append_log(f"[manager] Process {pid} exited gracefully.")
            except asyncio.TimeoutError:
                self._append_log(f"[manager] SIGTERM timeout, sending SIGKILL...")
                self._process.kill()
                await self._process.wait()
                self._append_log(f"[manager] Process {pid} killed.")
        except ProcessLookupError:
            self._append_log(f"[manager] Process {pid} already exited.")

    def clear_logs(self):
        self._log_buffer.clear()
        self._append_log("[manager] Logs cleared.")

    def get_logs(self) -> List[str]:
        return list(self._log_buffer)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._log_subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self._log_subscribers:
            self._log_subscribers.remove(q)


# Singleton
process_manager = ProcessManager()
