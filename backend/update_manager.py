"""Update management — git pull + cmake compile for llama.cpp."""
from __future__ import annotations
import asyncio
import subprocess
import sys
from typing import List
from pathlib import Path


class UpdateManager:
    def __init__(self):
        self._compile_process: asyncio.subprocess.Process | None = None
        self._compile_log: List[str] = []
        self._is_compiling: bool = False
        self._subscribers: List[asyncio.Queue] = []

    def _append(self, text: str):
        self._compile_log.append(text)
        for q in list(self._subscribers):
            try:
                q.put_nowait(text)
            except Exception:
                self._subscribers.remove(q)

    async def check_update(self, llama_cpp_dir: str) -> dict:
        """Check if there are remote updates available."""
        d = Path(llama_cpp_dir)
        if not (d / ".git").exists():
            return {"has_update": False, "error": "Not a git repository"}

        try:
            # Get current commit
            r1 = subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"],
                capture_output=True, text=True, cwd=str(d), timeout=30
            )
            current = r1.stdout.strip()

            # Fetch (dry-run style — just fetch, don't merge)
            r2 = subprocess.run(
                ["git", "fetch"],
                capture_output=True, text=True, cwd=str(d), timeout=60
            )

            # Get remote commit
            r3 = subprocess.run(
                ["git", "rev-parse", "--short", "origin/main"],
                capture_output=True, text=True, cwd=str(d), timeout=30
            )
            # Try origin/master if origin/main fails
            if r3.returncode != 0:
                r3 = subprocess.run(
                    ["git", "rev-parse", "--short", "origin/master"],
                    capture_output=True, text=True, cwd=str(d), timeout=30
                )
            remote = r3.stdout.strip()

            return {
                "has_update": current != remote,
                "current_commit": current,
                "remote_commit": remote,
            }
        except Exception as e:
            return {"has_update": False, "error": str(e)}

    async def pull_update(self, llama_cpp_dir: str, force: bool = False) -> dict:
        """Pull latest changes. If force=True, reset to remote first."""
        d = Path(llama_cpp_dir)
        try:
            if force:
                # Stash local changes and reset to remote
                subprocess.run(["git", "stash"], capture_output=True, text=True, cwd=str(d), timeout=30)
                subprocess.run(["git", "fetch", "origin"], capture_output=True, text=True, cwd=str(d), timeout=60)
                # Detect default branch
                r0 = subprocess.run(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], capture_output=True, text=True, cwd=str(d), timeout=10)
                branch = r0.stdout.strip().replace("refs/remotes/origin/", "") if r0.returncode == 0 else "master"
                subprocess.run(["git", "reset", "--hard", f"origin/{branch}"], capture_output=True, text=True, cwd=str(d), timeout=30)

            r = subprocess.run(
                ["git", "pull"],
                capture_output=True, text=True, cwd=str(d), timeout=120
            )
            return {
                "success": r.returncode == 0,
                "output": r.stdout + r.stderr,
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def start_compile(self, llama_cpp_dir: str, command: str):
        """Start cmake compile in background."""
        if self._is_compiling:
            raise RuntimeError("Compile already in progress.")

        self._compile_log.clear()
        self._is_compiling = True
        self._append(f"[compile] Working dir: {llama_cpp_dir}")
        self._append(f"[compile] Command: {command}")

        try:
            self._compile_process = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=llama_cpp_dir,
            )
            self._append(f"[compile] Started, PID={self._compile_process.pid}")
            asyncio.create_task(self._read_output())
        except Exception as e:
            self._is_compiling = False
            self._append(f"[compile] Failed to start: {e}")
            raise

    async def _read_output(self):
        if not self._compile_process or not self._compile_process.stdout:
            return
        try:
            async for line in self._compile_process.stdout:
                text = line.decode("utf-8", errors="replace").rstrip()
                self._append(text)
        except Exception as e:
            self._append(f"[compile] Reader error: {e}")
        finally:
            rc = self._compile_process.returncode if self._compile_process else -1
            self._append(f"[compile] Finished with exit code {rc}")
            self._is_compiling = False

    def get_compile_logs(self) -> List[str]:
        return list(self._compile_log)

    async def stop(self):
        if self._compile_process and self._compile_process.returncode is None:
            self._append("[compile] Stopping...")
            if sys.platform == "win32":
                kill = await asyncio.create_subprocess_exec("taskkill","/F","/T","/PID",str(self._compile_process.pid),
                    stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)
                await kill.wait()
            else:
                self._compile_process.terminate()
            self._append("[compile] Stopped.")
            self._is_compiling = False

    def is_compiling(self) -> bool:
        return self._is_compiling

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self._subscribers:
            self._subscribers.remove(q)


update_manager = UpdateManager()
