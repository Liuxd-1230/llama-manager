"""Download/clone llama.cpp to a local directory."""
from __future__ import annotations
import asyncio
from pathlib import Path
from typing import List


class DownloadManager:
    def __init__(self):
        self._process: asyncio.subprocess.Process | None = None
        self._log_buffer: List[str] = []
        self._is_downloading: bool = False
        self._subscribers: List[asyncio.Queue] = []

    def _append(self, text: str):
        self._log_buffer.append(text)
        for q in list(self._subscribers):
            try:
                q.put_nowait(text)
            except Exception:
                self._subscribers.remove(q)

    async def start_download(self, target_dir: str):
        """Clone llama.cpp into target_dir/llama.cpp."""
        if self._is_downloading:
            raise RuntimeError("Download already in progress.")

        target = Path(target_dir)
        target.mkdir(parents=True, exist_ok=True)
        dest = target / "llama.cpp"

        if dest.exists() and (dest / ".git").exists():
            self._append(f"[download] {dest} already exists, skipping clone.")
            return

        self._log_buffer.clear()
        self._is_downloading = True
        self._append(f"[download] Cloning llama.cpp to {dest}...")

        try:
            self._process = await asyncio.create_subprocess_exec(
                "git", "clone", "--depth=1", "https://github.com/ggml-org/llama.cpp.git", str(dest),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            self._append(f"[download] Started, PID={self._process.pid}")
            asyncio.create_task(self._read_output(str(dest)))
        except Exception as e:
            self._is_downloading = False
            self._append(f"[download] Failed: {e}")
            raise

    async def _read_output(self, dest: str):
        if not self._process or not self._process.stdout:
            return
        try:
            async for line in self._process.stdout:
                text = line.decode("utf-8", errors="replace").rstrip()
                self._append(text)
        except Exception as e:
            self._append(f"[download] Error: {e}")
        finally:
            rc = self._process.returncode if self._process else -1
            if rc == 0:
                self._append(f"[download] ✅ Done! llama.cpp cloned to {dest}")
                self._append(f"[download] Set llama.cpp directory to: {dest}")
            else:
                self._append(f"[download] ❌ Failed with exit code {rc}")
            self._is_downloading = False

    def get_logs(self) -> List[str]:
        return list(self._log_buffer)

    def is_downloading(self) -> bool:
        return self._is_downloading

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self._subscribers:
            self._subscribers.remove(q)


download_manager = DownloadManager()
