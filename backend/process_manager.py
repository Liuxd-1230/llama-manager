"""llama-server process management with real-time log streaming."""
from __future__ import annotations
import asyncio
import shlex
import subprocess
import time
import sys
import os
from pathlib import Path
from typing import Optional, List, Any
from .models import AppConfig, ServerStatus
from .config_manager import detect_server_binary, detect_kvmem_binary, detect_ninfer_binary

IS_WINDOWS = sys.platform == "win32"

ENGINE_IMAGE_NAMES = ("llama-server", "llama-kvmem-server", "ninfer-serve")


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


class ProcessManager:
    def __init__(self):
        self._process: Optional[asyncio.subprocess.Process] = None
        self._start_time: float = 0
        self._log_buffer: List[str] = []
        self._log_subscribers: List[Any] = []  # WebSocket connections
        self._max_log_lines: int = 5000
        self._profile_name: str = ""

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
                error=f"Exit code: {self._process.returncode}",
            )
        return ServerStatus(state="stopped")

    def build_command(self, config: AppConfig) -> list[str]:
        """Build the llama-server / llama-kvmem-server / ninfer-serve command line from config."""
        if config.engine == "kvmem":
            return self._build_kvmem_command(config)
        if config.engine == "ninfer":
            return self._build_ninfer_command(config)

        server_bin = detect_server_binary(config.llama_cpp_dir)
        if not server_bin:
            raise FileNotFoundError(
                f"llama-server not found in {config.llama_cpp_dir}/build/bin/"
            )

        cmd = [server_bin]
        cmd += ["-m", config.model_path]

        if config.mmproj_path:
            cmd += ["--mmproj", config.mmproj_path]
            cmd += ["--mmproj-offload" if config.mmproj_gpu else "--no-mmproj-offload"]

        b = config.basic
        cmd += ["-c", str(b.ctx_size)]
        if b.fit_enabled:
            cmd += ["--fit", "on"]
        elif b.ngl_enabled:
            cmd += ["-ngl", str(b.ngl)]
        else:
            cmd += ["-ngl", "0"]
        cmd += ["-t", str(b.threads)]
        cmd += ["-np", str(b.parallel)]

        # mmap is the engine default; current llama.cpp builds reject a bare
        # --mmap, so only the opt-out needs a flag.
        if not b.mmap:
            cmd.append("--no-mmap")
        if b.mlock:
            cmd.append("--mlock")

        if b.n_cpu_moe > 0:
            cmd += ["--n-cpu-moe", str(b.n_cpu_moe)]

        if b.kv_cache_quant_k:
            cmd += ["--cache-type-k", b.kv_cache_quant_k]
        if b.kv_cache_quant_v:
            cmd += ["--cache-type-v", b.kv_cache_quant_v]

        if b.enable_thinking:
            cmd += ["--reasoning", "on"]

        # KV cache offload to GPU
        if not b.kv_offload:
            cmd.append("--no-kv-offload")

        # Flash attention
        if b.flash_attn:
            cmd += ["--flash-attn", "on"]

        # Target margin for llama.cpp auto-fit.
        if b.fit_enabled and b.fit_target > 0:
            cmd += ["--fit-target", str(b.fit_target)]

        # Unified KV buffer
        if not b.kv_unified:
            cmd.append("--no-kv-unified")

        # Batch sizes
        cmd += ["-b", str(b.batch_size)]
        cmd += ["-ub", str(b.ubatch_size)]

        # Context shift
        if b.context_shift:
            cmd.append("--context-shift")

        # Cache RAM limit
        if b.cache_ram >= 0:
            cmd += ["--cache-ram", str(b.cache_ram)]

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

        if config.chat_template_file.strip():
            cmd += ["--chat-template-file", config.chat_template_file.strip()]

        # MTP speculative decoding
        mtp = config.mtp
        if mtp.enabled:
            cmd += ["--spec-type", mtp.spec_type]
            cmd += ["--spec-draft-n-max", str(mtp.draft_n_max)]
            if mtp.draft_n_min > 0:
                cmd += ["--spec-draft-n-min", str(mtp.draft_n_min)]
            if mtp.p_min != 0.0:
                cmd += ["--spec-draft-p-min", str(mtp.p_min)]
            if mtp.p_split != 0.10:
                cmd += ["--spec-draft-p-split", str(mtp.p_split)]

        if config.extra_params.strip():
            try:
                cmd += shlex.split(config.extra_params, posix=(not IS_WINDOWS))
            except ValueError as e:
                raise ValueError(f"extra_params 语法错误: {e}") from e

        return cmd

    def _build_kvmem_command(self, config: AppConfig) -> list[str]:
        """Build the llama-kvmem-server command line (KV virtualization engine)."""
        k = config.kvmem
        if k.budget + k.gen_reserve > k.workspace:
            raise ValueError(
                f"KVMem: budget({k.budget}) + gen_reserve({k.gen_reserve}) 不能超过 workspace({k.workspace})"
            )

        server_bin = detect_kvmem_binary(config.llama_cpp_dir)
        if not server_bin:
            raise FileNotFoundError(
                f"llama-kvmem-server not found in {config.llama_cpp_dir}/ (root or bin/)"
            )

        cmd = [server_bin, "-m", config.model_path]
        if config.mmproj_path:
            cmd += ["--mmproj", config.mmproj_path]
            # The projector defaults to system RAM: on the 8GB card its VRAM
            # footprint crowds out decode. --mmproj-offload opts into VRAM.
            cmd += ["--mmproj-offload" if config.mmproj_gpu else "--no-mmproj-offload"]
        if config.basic.ngl_enabled:
            cmd += ["-ngl", str(config.basic.ngl)]
        cmd += ["--host", config.server.host, "--port", str(config.server.port)]
        # In KVMem, -c is the logical KV workspace, not a VRAM cap; VRAM = budget + gen_reserve.
        cmd += ["-c", str(k.workspace), "-b", str(k.batch), "--ubatch-size", str(k.ubatch), "-n", str(k.gen_reserve)]
        cmd += [
            "--kvmem-budget", str(k.budget),
            "--kvmem-gen-reserve", str(k.gen_reserve),
            "--kvmem-block-tokens", str(k.block_tokens),
            "--kvmem-query-policy", k.query_policy,
            "--kvmem-query-replay", "auto",
            "--kv-dtype", k.kv_dtype,
        ]
        # Serve the package's built-in WebUI when present (prism/rc packages).
        for base in (Path(server_bin).parent.parent, Path(server_bin).parent):
            ui_dir = base / "share" / "kvmem" / "ui"
            if ui_dir.is_dir():
                cmd += ["--ui-dir", str(ui_dir), "--webui"]
                break
        if config.basic.flash_attn:
            cmd += ["--flash-attn", "on"]
        if k.enable_thinking:
            # reasoning-budget caps THINKING tokens; -n (= gen_reserve) caps the
            # whole output. Keep at least 1024 tokens of headroom for the answer
            # or the model gets cut mid-thinking with nothing left to say.
            thinking_budget = max(0, min(k.reasoning_budget, k.gen_reserve - 1024))
            cmd += ["--enable-thinking", "--reasoning-budget", str(thinking_budget)]
        if config.chat_template_file.strip():
            cmd += ["--chat-template-file", config.chat_template_file.strip()]
        if config.mtp.enabled:
            # Experimental: requires a model with a merged MTP head (prism.3 flow).
            cmd += [
                "--spec-type", "draft-mtp",
                "--spec-draft-n-max", str(max(1, config.mtp.draft_n_max)),
                "--spec-kv-dtype", "f16",
                "--kvmem-mtp-state", k.mtp_state,
            ]
        else:
            cmd += ["--spec-type", "none"]

        if config.extra_params.strip():
            try:
                cmd += shlex.split(config.extra_params, posix=(not IS_WINDOWS))
            except ValueError as e:
                raise ValueError(f"extra_params 语法错误: {e}") from e
        return cmd

    def _build_ninfer_command(self, config: AppConfig) -> list[str]:
        """Build the ninfer-serve command line (.ninfer artifact engine)."""
        n = config.ninfer
        server_bin = detect_ninfer_binary(config.llama_cpp_dir)
        if not server_bin:
            raise FileNotFoundError(
                f"ninfer-serve not found in {config.llama_cpp_dir}/ (root or engine/)"
            )

        cmd = [server_bin, config.model_path]
        cmd += ["--host", config.server.host, "--port", str(config.server.port)]
        cmd += ["--max-context", str(n.max_context)]
        if n.kv_capacity > 0:
            cmd += ["--kv-capacity", str(n.kv_capacity)]
        cmd += ["--kv-dtype", n.kv_dtype, "--host-kv-mib", str(n.host_kv_mib)]
        if n.prefill_chunk > 0:
            # Must be a multiple of 128 or the engine refuses to start.
            chunk = max(128, (n.prefill_chunk // 128) * 128)
            cmd += ["--prefill-chunk", str(chunk)]
        cmd += ["--max-concurrency", str(n.max_concurrency)]
        cmd += ["--default-max-tokens", str(n.default_max_tokens)]
        if not n.cuda_graph:
            cmd.append("--no-cuda-graph")
        # Browsers reach the engine cross-origin via the manager-hosted chat
        # page (the pack binary serves no WebUI of its own).
        cmd.append("--cors")
        if n.spec != "none":
            cmd += ["--spec", n.spec, "--draft-tokens", str(max(1, min(n.draft_tokens, 15)))]
            if n.adaptive_mtp:
                cmd.append("--adaptive-mtp")

        # Server-side sampling defaults; per-request fields override them.
        s = config.sampling
        cmd += ["--temperature", str(s.temperature), "--top-p", str(s.top_p)]
        # The engine only accepts top-k 0..20.
        cmd += ["--top-k", str(max(0, min(s.top_k, 20)))]
        if s.min_p_enabled:
            cmd += ["--min-p", str(s.min_p)]
        if s.presence_penalty_enabled:
            cmd += ["--presence-penalty", str(s.presence_penalty)]

        # Thinking: the shared switch maps onto the reasoning-effort knob.
        cmd += ["--default-reasoning-effort", n.reasoning_effort if config.basic.enable_thinking else "none"]
        if n.model_id.strip():
            cmd += ["--model-id", n.model_id.strip()]

        if config.extra_params.strip():
            try:
                cmd += shlex.split(config.extra_params, posix=(not IS_WINDOWS))
            except ValueError as e:
                raise ValueError(f"extra_params 语法错误: {e}") from e
        return cmd

    def build_env(self, config: AppConfig) -> dict[str, str] | None:
        """Child-process environment. Only the NInfer engine needs extra vars
        (the KVMem ring configuration); None inherits the parent environment."""
        if config.engine != "ninfer":
            return None
        n = config.ninfer
        env = dict(os.environ)
        if n.kv_window > 0:
            # Ring retrieval config, verbatim from the pack launchers. The
            # content scorer turns itself on whenever NINFER_KV_WINDOW is set.
            env["NINFER_KV_WINDOW"] = str(n.kv_window)
            env["NINFER_KV_RETRIEVE"] = str(n.kv_retrieve)
            env["NINFER_KV_RING"] = "1"
            env["NINFER_HOST_PAGEABLE"] = "1"
            env["NINFER_KV_REUSE_HOSTBACKED"] = "1"
            if n.ptq1_fast:
                env["NINFER_TERNARY_PTQ1_FAST"] = "1"
            else:
                env.pop("NINFER_TERNARY_PTQ1_FAST", None)
        # Serve the pack's own WebUI when present (engine sits in <pack>/engine).
        pack_ui = Path(detect_ninfer_binary(config.llama_cpp_dir) or "").parent.parent / "webui"
        if pack_ui.is_dir():
            env["NINFER_WEBUI_DIR"] = str(pack_ui)
        return env

    async def start(self, config: AppConfig, profile_name: str = ""):
        if self._process and self._process.returncode is None:
            raise RuntimeError("Server is already running. Stop it first.")

        cmd = self.build_command(config)
        env = self.build_env(config)
        self._profile_name = profile_name
        self._log_buffer.clear()
        self._append_log(f"[manager] Starting: {' '.join(cmd)}")
        if env is not None:
            ring = {k: v for k, v in env.items() if k.startswith("NINFER_")}
            if ring:
                self._append_log(f"[manager] Engine env: {' '.join(f'{k}={v}' for k, v in sorted(ring.items()))}")

        self._process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=config.llama_cpp_dir or None,
            env=env,
        )
        self._start_time = time.time()
        record_engine_pid(self._process.pid)
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
        finally:
            # Settle the exit status: on Windows, returncode stays None until
            # wait() runs, which would leave a crashed server looking alive.
            try:
                if self._process and self._process.returncode is None:
                    await self._process.wait()
            except ProcessLookupError:
                pass

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
                self._process.terminate()
                try:
                    await asyncio.wait_for(self._process.wait(), timeout=10)
                    self._append_log(f"[manager] Process {pid} exited gracefully.")
                except asyncio.TimeoutError:
                    self._append_log(f"[manager] Terminate timeout, killing...")
                    self._process.kill()
                    await self._process.wait()
                    self._append_log(f"[manager] Process {pid} killed.")
        except ProcessLookupError:
            self._append_log(f"[manager] Process {pid} already exited.")
        finally:
            # Reap the killed process so a subsequent start() does not race on returncode.
            try:
                if self._process and self._process.returncode is None:
                    await self._process.wait()
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
        q: asyncio.Queue = asyncio.Queue()
        self._log_subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self._log_subscribers:
            self._log_subscribers.remove(q)


# Singleton
process_manager = ProcessManager()
