"""Per-user DPAPI secret storage; environment variables remain authoritative."""
from __future__ import annotations
import base64
import ctypes
from ctypes import wintypes
import json
import logging
import os
import re
from .paths import APP_DATA_DIR

_redactions: set[str] = set()


class SecretFilter(logging.Filter):
    def filter(self, record):
        def redact(value):
            if isinstance(value,str):
                for secret in _redactions: value=value.replace(secret,'[redacted]')
                return re.sub(r'\bhf_[A-Za-z0-9]+','[redacted]',value)
            if isinstance(value,tuple): return tuple(redact(item) for item in value)
            if isinstance(value,list): return [redact(item) for item in value]
            if isinstance(value,dict): return {key:redact(item) for key,item in value.items()}
            return value
        # AccessFormatter inspects its five typed arguments before formatting.
        # Flattening them into msg breaks every request log and floods stderr.
        record.msg=redact(record.msg)
        record.args=redact(record.args)
        return True


def configure_redaction():
    loggers = [logging.getLogger(), *[logger for logger in logging.Logger.manager.loggerDict.values() if isinstance(logger, logging.Logger)]]
    for logger in loggers:
        for handler in logger.handlers:
            if not any(isinstance(item, SecretFilter) for item in handler.filters):
                handler.addFilter(SecretFilter())


class Blob(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_byte))]


def _crypt(value: bytes, decrypt: bool = False) -> bytes:
    if os.name != 'nt':
        raise RuntimeError('保存密钥需要 Windows DPAPI；其他系统请使用环境变量')
    buffer = ctypes.create_string_buffer(value)
    source = Blob(len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    output = Blob()
    fn = ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    if not fn(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise RuntimeError('Windows 无法加密或解密密钥')
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        ctypes.windll.kernel32.LocalFree(output.data)


def read_secret(name: str) -> str:
    path = APP_DATA_DIR / 'secrets' / 'vault.json'
    values = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    value = _crypt(base64.b64decode(values[name]), True).decode() if values.get(name) else ''
    if value:
        _redactions.add(value)
    return value


def write_secret(name: str, value: str) -> None:
    path = APP_DATA_DIR / 'secrets' / 'vault.json'
    values = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    if value:
        _redactions.add(value)
        values[name] = base64.b64encode(_crypt(value.encode())).decode()
    else:
        values.pop(name, None)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(values), encoding='utf-8')
    temp.replace(path)
