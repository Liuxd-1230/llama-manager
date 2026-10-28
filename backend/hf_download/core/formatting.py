"""格式化工具：文件大小、速度、ETA。"""

from __future__ import annotations

UNITS = ["B", "KB", "MB", "GB", "TB", "PB"]


def human_size(n: int | float | None) -> str:
    if n is None:
        return "—"
    n = float(n)
    neg = n < 0
    n = abs(n)
    i = 0
    while n >= 1024 and i < len(UNITS) - 1:
        n /= 1024.0
        i += 1
    if i == 0:
        s = f"{int(n)} {UNITS[i]}"
    else:
        s = f"{n:.1f} {UNITS[i]}"
    return f"-{s}" if neg else s


def human_speed(bps: float | None) -> str:
    if not bps or bps <= 0:
        return "—"
    return f"{human_size(bps)}/s"


def format_eta(seconds: float | None) -> str:
    if seconds is None or seconds < 0 or seconds != seconds:  # NaN check
        return "—"
    seconds = int(seconds)
    if seconds >= 3600:
        h, rem = divmod(seconds, 3600)
        m, s = divmod(rem, 60)
        return f"{h}小时{m:02d}分"
    if seconds >= 60:
        m, s = divmod(seconds, 60)
        return f"{m:02d}:{s:02d}"
    return f"00:{seconds:02d}"
