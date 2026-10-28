"""Hugging Face API 封装：仓库文件列表、镜像测试。

统一走 HfApi(endpoint=镜像) —— hf-mirror 等镜像站完整代理官方 API，
所有请求优先复用 huggingface_hub 能力。
"""

from __future__ import annotations

import logging
import time

import requests

from ..models import RepoFile

logger = logging.getLogger(__name__)


def build_api(endpoint: str, token: str | None = None):
    from huggingface_hub import HfApi

    return HfApi(endpoint=endpoint.rstrip("/"), token=token or None)


def _is_fatal_listing_error(exc: Exception) -> bool:
    """仓库不存在 / 需要授权等错误不应降级重试，直接抛出给用户。"""
    try:
        from huggingface_hub import errors as hf_err
    except Exception:  # noqa: BLE001
        return False
    if isinstance(exc, (hf_err.RepositoryNotFoundError, hf_err.GatedRepoError,
                        hf_err.RevisionNotFoundError, hf_err.EntryNotFoundError)):
        return True
    if isinstance(exc, hf_err.HfHubHTTPError):
        status = getattr(getattr(exc, "response", None), "status_code", None)
        return status in (401, 403, 404)
    return False


def _files_via_tree(api, repo_id: str, revision: str) -> list[RepoFile]:
    """首选：list_repo_tree(expand=True)，一次分页拿到全部大小。"""
    from huggingface_hub.hf_api import RepoFolder

    files: list[RepoFile] = []
    for entry in api.list_repo_tree(repo_id, revision=revision, recursive=True, expand=True):
        if isinstance(entry, RepoFolder):
            continue  # 目录
        path = getattr(entry, "path", None)
        if path is None:
            continue
        lfs = getattr(entry, "lfs", None)
        size = (lfs.size if lfs is not None else None) or getattr(entry, "size", None)
        files.append(
            RepoFile(
                path=path,
                size=int(size) if size is not None else None,
                is_lfs=lfs is not None,
                oid=getattr(entry, "blob_id", None),
                lfs_sha256=(lfs.sha256 if lfs is not None else None),
            )
        )
    return files


def _files_via_model_info(api, repo_id: str, revision: str) -> list[RepoFile]:
    """次选：model_info(files_metadata=True)，走另一个端点，同样带大小。"""
    info = api.model_info(repo_id, revision=revision, files_metadata=True)
    files: list[RepoFile] = []
    for sib in getattr(info, "siblings", None) or []:
        name = getattr(sib, "rfilename", None)
        if not name:
            continue
        lfs = getattr(sib, "lfs", None)
        size = getattr(sib, "size", None)
        if size is None and lfs is not None:
            size = getattr(lfs, "size", None)
        files.append(
            RepoFile(
                path=name,
                size=int(size) if size is not None else None,
                is_lfs=lfs is not None,
                oid=getattr(sib, "blob_id", None),
                lfs_sha256=(getattr(lfs, "sha256", None) if lfs is not None else None),
            )
        )
    return files


def list_repo_files_full(
    endpoint: str,
    repo_id: str,
    revision: str = "main",
    token: str | None = None,
) -> list[RepoFile]:
    """列出仓库全部文件（含子目录），尽量带上大小。

    三级策略（每级遇到瞬时错误自动进入下一级；401/403/404 直接抛出）：
      1. list_repo_tree(expand=True)   —— 一次拿全大小
      2. model_info(files_metadata=True) —— 不同端点，同样带大小
      3. list_repo_files               —— 只有文件名（大小显示为 —）
    """
    api = build_api(endpoint, token)
    last_exc: Exception | None = None

    files: list[RepoFile] | None = None
    for attempt in range(2):  # 镜像偶发 5xx / 超时，重试一次
        try:
            files = _files_via_tree(api, repo_id, revision)
            logger.info("列出仓库 %s@%s：%d 个文件（tree expand）", repo_id, revision, len(files))
            break
        except Exception as exc:  # noqa: BLE001
            if _is_fatal_listing_error(exc):
                raise
            last_exc = exc
            logger.warning("list_repo_tree 第 %d 次失败：%s", attempt + 1, exc)
            time.sleep(0.4)

    # tree 失败，或 tree 成功但部分大小缺失（镜像 expand 未返回 LFS 大小）→ 用 model_info 补全
    if files is None or any(f.size is None for f in files):
        try:
            mi_files = _files_via_model_info(api, repo_id, revision)
            if files is None:
                files = mi_files
                logger.info("列出仓库 %s@%s：%d 个文件（model_info 降级）", repo_id, revision, len(files))
            else:
                by_path = {f.path: f for f in mi_files}
                filled = 0
                for f in files:
                    if f.size is None:
                        m = by_path.get(f.path)
                        if m and m.size is not None:
                            f.size = m.size
                            f.is_lfs = f.is_lfs or m.is_lfs
                            f.lfs_sha256 = f.lfs_sha256 or m.lfs_sha256
                            f.oid = f.oid or m.oid
                            filled += 1
                if filled:
                    logger.info("用 model_info 补全了 %d 个缺失大小", filled)
        except Exception as exc:  # noqa: BLE001
            if _is_fatal_listing_error(exc):
                raise
            last_exc = last_exc or exc
            logger.warning("model_info 降级也失败：%s", exc)

    if files is None:
        names = api.list_repo_files(repo_id, revision=revision)
        files = [RepoFile(path=n) for n in names]
        logger.warning(
            "列出仓库 %s@%s：%d 个文件（仅文件名，无大小；原因：%s）",
            repo_id, revision, len(files), last_exc,
        )
    return files


def test_mirror(endpoint: str, timeout: float = 8.0) -> dict:
    """测试镜像可用性：DNS/连通性、延迟、HTTP 状态。

    返回 {ok, latency_ms, status, message, endpoint}。
    """
    endpoint = endpoint.rstrip("/")
    result = {"ok": False, "latency_ms": None, "status": None, "message": "", "endpoint": endpoint}
    start = time.monotonic()
    try:
        resp = requests.get(f"{endpoint}/api/models/gpt2", timeout=timeout, headers={"Accept-Encoding": "identity"})
        latency = (time.monotonic() - start) * 1000
        result["latency_ms"] = latency
        result["status"] = resp.status_code
        if resp.status_code == 200:
            result["ok"] = True
            result["message"] = f"连接正常，延迟 {latency:.0f} ms"
        elif resp.status_code in (401, 403):
            # gpt2 是公开模型，401/403 说明镜像行为异常
            result["message"] = f"服务器返回 HTTP {resp.status_code}，镜像可能限制访问"
        else:
            result["message"] = f"服务器返回 HTTP {resp.status_code}"
    except requests.exceptions.SSLError as exc:
        result["message"] = f"SSL 证书验证失败：{exc.__class__.__name__}"
    except requests.exceptions.ConnectTimeout:
        result["message"] = "连接超时：DNS 已解析但服务器无响应"
    except requests.exceptions.ConnectionError:
        result["message"] = "无法连接：请检查网络、代理或防火墙"
    except requests.exceptions.Timeout:
        result["message"] = "请求超时"
    except Exception as exc:  # noqa: BLE001
        result["message"] = f"未知错误：{exc.__class__.__name__}: {exc}"
    logger.info("镜像测试 %s → ok=%s %s", endpoint, result["ok"], result["message"])
    return result
