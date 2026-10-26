"""Host resource readings for the top bar: RAM via Win32, VRAM via nvidia-smi.

No third-party dependencies: ctypes hits GlobalMemoryStatusEx and nvidia-smi is
shelled out (this project already targets Windows + NVIDIA laptops).
"""

from __future__ import annotations

import subprocess
import sys
from typing import Optional

_CACHE_TTL = 1.5
_cache: dict[str, object] = {"at": 0.0, "payload": None}


def _ram_mib() -> Optional[dict]:
    if sys.platform != "win32":
        try:
            with open("/proc/meminfo", encoding="utf-8") as fh:
                info = {line.split(":")[0]: int(line.split()[1]) for line in fh if ":" in line}
            total = info.get("MemTotal", 0) // 1024
            available = info.get("MemAvailable", 0) // 1024
            return {"total_mib": total, "used_mib": total - available}
        except Exception:
            return None
    try:
        import ctypes
        from ctypes import wintypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", wintypes.DWORD),
                ("dwMemoryLoad", wintypes.DWORD),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        status = MEMORYSTATUSEX()
        status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return None
        mib = 1024 * 1024
        return {"total_mib": status.ullTotalPhys // mib, "used_mib": (status.ullTotalPhys - status.ullAvailPhys) // mib}
    except Exception:
        return None


def _vram_mib() -> Optional[dict]:
    try:
        completed = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if completed.returncode != 0:
            return None
        used = total = 0
        for line in completed.stdout.strip().splitlines():
            parts = [piece.strip() for piece in line.split(",")]
            if len(parts) >= 2:
                used += int(float(parts[0]))
                total += int(float(parts[1]))
        if total <= 0:
            return None
        return {"used_mib": used, "total_mib": total}
    except Exception:
        return None


def read_resources() -> dict:
    """Cached host readings; every field is optional and degrades to None."""
    import time

    now = time.time()
    cached = _cache.get("payload")
    if cached is not None and now - float(_cache.get("at") or 0) < _CACHE_TTL:
        return cached  # type: ignore[return-value]
    payload = {"ram": _ram_mib(), "gpu": _vram_mib()}
    _cache["at"] = now
    _cache["payload"] = payload
    return payload
