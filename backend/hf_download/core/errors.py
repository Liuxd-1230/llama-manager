"""错误分类与中文翻译。

所有下载/解析过程中出现的异常都会经过 translate_exception() 转换成
用户能看懂的中文短句；原始 traceback 只进日志，不进界面。
"""

from __future__ import annotations

import socket
from dataclasses import dataclass


# 错误大类，UI 据此决定是否弹出 Token 输入、是否允许重试
KIND_NETWORK = "network"      # 网络失败，可重试
KIND_AUTH = "auth"            # 需要 Token / 未接受许可，重试前需先填 Token
KIND_NOTFOUND = "notfound"    # 仓库 / 文件 / 版本不存在，重试无意义
KIND_LOCAL = "local"          # 本地问题：磁盘满、权限、路径过长、文件被占用
KIND_UNKNOWN = "unknown"


@dataclass
class FriendlyError(Exception):
    """带分类的中文错误。original 用于日志记录。"""

    kind: str
    message: str
    original: BaseException | None = None

    def __str__(self) -> str:  # pragma: no cover - 显示用
        return self.message


# huggingface_hub / requests 的异常延迟导入，避免模块加载顺序问题
def _hf_errors():
    from huggingface_hub import errors as hf_errors

    return hf_errors


def classify_status(status: int) -> str:
    if status in (401, 403):
        return KIND_AUTH
    if status == 404:
        return KIND_NOTFOUND
    if 500 <= status <= 599:
        return KIND_NETWORK
    return KIND_UNKNOWN


_AUTH_MESSAGE = (
    "该模型可能需要登录 Hugging Face 或接受模型许可。\n"
    "请到「设置」中填写 HF Token，并在模型页面上同意许可协议（gated 模型需要先申请访问权限）。"
)


def translate_exception(exc: BaseException, endpoint: str = "") -> FriendlyError:
    """把任意异常翻译成 FriendlyError(kind, 中文消息)。"""

    try:
        hf_err = _hf_errors()
    except Exception:  # pragma: no cover
        hf_err = None

    status = getattr(exc, "response", None)
    status = getattr(status, "status_code", None)

    if hf_err is not None:
        if isinstance(exc, hf_err.RepositoryNotFoundError):
            return FriendlyError(KIND_NOTFOUND, "仓库不存在：请检查链接 / 仓库名是否正确，或该仓库是否已删除、转为私有。", exc)
        if isinstance(exc, hf_err.EntryNotFoundError):
            return FriendlyError(KIND_NOTFOUND, "文件不存在：该文件可能已被移除、改名，或不在当前分支中。", exc)
        if isinstance(exc, hf_err.RevisionNotFoundError):
            return FriendlyError(KIND_NOTFOUND, "版本（分支 / tag）不存在：请检查链接中的分支名。", exc)
        if isinstance(exc, hf_err.GatedRepoError):
            return FriendlyError(KIND_AUTH, _AUTH_MESSAGE, exc)
        if isinstance(exc, hf_err.HfHubHTTPError):
            if status in (401, 403):
                msg = _AUTH_MESSAGE
                if status == 401:
                    msg = "Token 无效或已过期，服务器拒绝了请求。\n" + _AUTH_MESSAGE
                return FriendlyError(KIND_AUTH, msg, exc)
            if status == 404:
                return FriendlyError(KIND_NOTFOUND, "服务器返回 404：仓库、文件或版本不存在。", exc)
            if 500 <= status <= 599:
                return FriendlyError(
                    KIND_NETWORK,
                    f"镜像服务器错误（HTTP {status}）：可稍后重试，或到设置中更换下载源。",
                    exc,
                )

    # 本地文件系统错误（OSError 系）
    if isinstance(exc, PermissionError):
        return FriendlyError(KIND_LOCAL, "没有写入权限：请更换下载目录，或以管理员身份运行。", exc)
    if isinstance(exc, OSError):
        winerror = getattr(exc, "winerror", None)
        errno = getattr(exc, "errno", None)
        text = str(exc).lower()
        if winerror == 112 or errno == 28 or "no space left" in text or "磁盘空间不足" in str(exc):
            return FriendlyError(KIND_LOCAL, "磁盘空间不足：请清理目标磁盘或更换下载目录。", exc)
        if winerror == 32 or "being used by another process" in text:
            return FriendlyError(KIND_LOCAL, "文件被其他程序占用：请关闭正在使用该文件的程序（如模型加载器、杀毒软件）后重试。", exc)
        if winerror == 206 or errno == 36 or "filename or extension is too long" in text or "path too long" in text:
            return FriendlyError(KIND_LOCAL, "路径过长：Windows 限制约 260 字符，请选择更短的下载目录。", exc)
        if winerror in (3, 267) or errno == 2:
            return FriendlyError(KIND_LOCAL, "目录不存在或无法访问：请检查下载目录设置。", exc)
        return FriendlyError(KIND_LOCAL, f"本地文件读写失败：{exc}", exc)

    # 网络错误
    try:
        import requests
        from requests.exceptions import ChunkedEncodingError, ConnectionError as ReqConnectionError
        from requests.exceptions import ReadTimeout, ConnectTimeout, SSLError
    except Exception:  # pragma: no cover
        requests = None

    if requests is not None and isinstance(exc, (ReqConnectionError, ConnectTimeout, ReadTimeout, ChunkedEncodingError, SSLError, socket.timeout)):
        base = "网络连接失败：请检查网络，或稍后重试。"
        if endpoint:
            base += f"\n当前下载源：{endpoint}"
        if isinstance(exc, ReadTimeout):
            base = "网络超时：镜像响应过慢，可稍后重试或更换下载源。"
        return FriendlyError(KIND_NETWORK, base, exc)

    if isinstance(exc, FriendlyError):
        return exc

    return FriendlyError(KIND_UNKNOWN, f"发生未知错误：{type(exc).__name__}: {exc}", exc)


RETRYABLE_KINDS = {KIND_NETWORK, KIND_UNKNOWN}
