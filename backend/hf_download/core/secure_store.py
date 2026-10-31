"""HF Token 本地安全存储。

Windows 上使用 DPAPI（CryptProtectData）加密，绑定当前用户；
其他平台或 DPAPI 不可用时退回 base64 明文标记存储（仍不写入日志）。
"""

from __future__ import annotations

import base64
import logging
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

_MAGIC = b"HFTOKEN1\n"


def _dpapi_protect(data: bytes) -> bytes | None:
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class BLOB(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

        buf = ctypes.create_string_buffer(data, len(data))
        inp = BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
        out = BLOB()
        ok = ctypes.windll.crypt32.CryptProtectData(
            ctypes.byref(inp), None, None, None, None, 0, ctypes.byref(out)
        )
        if not ok:
            return None
        try:
            return ctypes.string_at(out.pbData, out.cbData)
        finally:
            ctypes.windll.kernel32.LocalFree(out.pbData)
    except Exception as exc:  # noqa: BLE001
        logger.warning("DPAPI 不可用，Token 将以标记编码存储：%s", exc)
        return None


def _dpapi_unprotect(data: bytes) -> bytes | None:
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class BLOB(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

        buf = ctypes.create_string_buffer(data, len(data))
        inp = BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
        out = BLOB()
        ok = ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(inp), None, None, None, None, 0, ctypes.byref(out)
        )
        if not ok:
            return None
        try:
            return ctypes.string_at(out.pbData, out.cbData)
        finally:
            ctypes.windll.kernel32.LocalFree(out.pbData)
    except Exception as exc:  # noqa: BLE001
        logger.warning("DPAPI 解密失败：%s", exc)
        return None


class TokenStore:
    def __init__(self, config_dir: str | Path):
        self.path = Path(config_dir) / "token.bin"

    def save(self, token: str) -> None:
        token = (token or "").strip()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not token:
            self.clear()
            return
        payload = token.encode("utf-8")
        enc = _dpapi_protect(payload)
        if enc is not None:
            blob = _MAGIC + b"DPAPI\n" + enc
        else:
            blob = _MAGIC + b"PLAIN\n" + base64.b64encode(payload)
        self.path.write_bytes(blob)
        logger.info("HF Token 已保存（%s）", "DPAPI 加密" if enc is not None else "未加密标记存储")

    def load(self) -> str | None:
        try:
            blob = self.path.read_bytes()
        except OSError:
            return None
        if not blob.startswith(_MAGIC):
            return None
        body = blob[len(_MAGIC):]
        if body.startswith(b"DPAPI\n"):
            raw = _dpapi_unprotect(body[len(b"DPAPI\n"):])
        elif body.startswith(b"PLAIN\n"):
            try:
                raw = base64.b64decode(body[len(b"PLAIN\n"):])
            except Exception:  # noqa: BLE001
                return None
        else:
            return None
        if raw:
            return raw.decode("utf-8", "replace").strip()
        return None

    def clear(self) -> None:
        try:
            self.path.unlink()
            logger.info("HF Token 已清除")
        except OSError:
            pass
