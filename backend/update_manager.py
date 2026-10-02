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

    @staticmethod
    def _mirror_url(origin_url: str, mirror_prefix: str) -> str:
        """Compose the fetch URL for a mirror prefix. SSH origins are converted
        to their https form — mirror prefixes proxy https only."""
        origin_url = origin_url.strip()
        if origin_url.startswith("git@"):
            origin_url = "https://github.com/" + origin_url.split(":", 1)[1]
        prefix = (mirror_prefix or "").strip().rstrip("/")
        if not prefix:
            return origin_url
        return f"{prefix}/{origin_url}"

    @staticmethod
    def _origin_url(d: Path) -> str:
        r = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True, cwd=str(d), timeout=10)
        if r.returncode != 0:
            raise ValueError("无法读取 origin 远程地址")
        return r.stdout.strip()

    async def check_update(self, llama_cpp_dir: str, mirror_prefix: str = "") -> dict:
        """Check for remote updates via git ls-remote — no object transfer."""
        d = Path(llama_cpp_dir)
        if not (d / ".git").exists():
            return {"has_update": False, "error": "Not a git repository"}
        try:
            r1 = await asyncio.to_thread(
                subprocess.run,
                ["git", "rev-parse", "--short", "HEAD"],
                capture_output=True, text=True, cwd=str(d), timeout=30
            )
            current = r1.stdout.strip()
            origin = self._origin_url(d)
            r0 = await asyncio.to_thread(
                subprocess.run,
                ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
                capture_output=True, text=True, cwd=str(d), timeout=10
            )
            branch = r0.stdout.strip().replace("refs/remotes/origin/", "") if r0.returncode == 0 else "master"
            final = self._mirror_url(origin, mirror_prefix)
            r2 = await asyncio.to_thread(
                subprocess.run,
                ["git", "ls-remote", final, branch],
                capture_output=True, text=True, timeout=60
            )
            if r2.returncode != 0:
                return {"has_update": False, "error": f"镜像探测失败: {r2.stderr.strip()[:200]}"}
            remote_full = (r2.stdout.splitlines() or [""])[0]
            remote = remote_full.split("	")[0][:7] if remote_full else ""
            return {
                "has_update": bool(remote) and current != remote,
                "current_commit": current,
                "remote_commit": remote,
            }
        except Exception as e:
            return {"has_update": False, "error": str(e)}

    async def pull_update(self, llama_cpp_dir: str, mirror_prefix: str = "", force: bool = False) -> dict:
        """Pull (or force-reset) from the selected mirror. The mirror URL is
        passed per-invocation — the checkout's own remote stays untouched."""
        d = Path(llama_cpp_dir)
        try:
            origin = self._origin_url(d)
            r0 = await asyncio.to_thread(
                subprocess.run,
                ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
                capture_output=True, text=True, cwd=str(d), timeout=10
            )
            branch = r0.stdout.strip().replace("refs/remotes/origin/", "") if r0.returncode == 0 else "master"
            final = self._mirror_url(origin, mirror_prefix)
            if force:
                await asyncio.to_thread(subprocess.run, ["git", "stash"], capture_output=True, text=True, cwd=str(d), timeout=30)
                await asyncio.to_thread(subprocess.run, ["git", "fetch", final, branch], capture_output=True, text=True, cwd=str(d), timeout=600)
                r = await asyncio.to_thread(subprocess.run, ["git", "reset", "--hard", "FETCH_HEAD"], capture_output=True, text=True, cwd=str(d), timeout=60)
            else:
                r = await asyncio.to_thread(
                    subprocess.run,
                    ["git", "pull", final, branch],
                    capture_output=True, text=True, cwd=str(d), timeout=600
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
            try:
                if self._compile_process and self._compile_process.returncode is None:
                    await self._compile_process.wait()
            except ProcessLookupError:
                pass
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
