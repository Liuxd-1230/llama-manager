"""把 Hugging Face 各种输入形式解析为 repo_id / revision / filename。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import unquote, urlparse, parse_qs


OFFICIAL_HOSTS = {"huggingface.co"}
MIRROR_HOSTS = {"hf-mirror.com", "hf-mirror.net"}

# repo_id：两段非空、不含空白，允许点、下划线、中划线等
_REPO_RE = re.compile(r"^[\w.\-]+\s*/\s*[\w.\-]+$", re.UNICODE)


@dataclass
class ParsedInput:
    repo_id: str
    revision: str = "main"
    filename: str = ""      # 包含子目录的相对路径，如 "onnx/model.onnx"；空表示整个仓库
    is_file: bool = False
    source: str = ""        # 原始输入

    @property
    def repo_url(self) -> str:
        return f"https://huggingface.co/{self.repo_id}"


class ParseError(ValueError):
    pass


def parse_input(text: str) -> ParsedInput:
    """解析用户粘贴的内容。

    支持：
      1) https://huggingface.co/{org}/{repo}
      2) org/repo
      3) https://huggingface.co/{org}/{repo}/blob/{rev}/{path}
      4) https://huggingface.co/{org}/{repo}/resolve/{rev}/{path}
      * 也接受镜像域名（hf-mirror.com / hf-mirror.net）、?query 参数、
        org/repo@revision 短格式、refs/pr/N 这类含斜杠的 revision。
    """
    raw = (text or "").strip().strip('"').strip("'").strip()
    if not raw:
        raise ParseError("请先粘贴仓库或文件链接。")

    repo_id, revision, filename = "", "main", ""

    if "://" in raw:
        parsed = urlparse(raw)
        host = (parsed.hostname or "").lower()
        known = host in OFFICIAL_HOSTS or host in MIRROR_HOSTS
        if not known:
            # 不认识的域名也尝试解析，方便自建反代；路径结构一样即可
            pass
        segments = [unquote(s) for s in parsed.path.split("/") if s.strip()]
        query = parse_qs(parsed.query)
        # ?download=true 等参数忽略
        _ = query

        if "datasets" in segments[:2]:
            raise ParseError("暂不支持数据集（datasets）仓库，目前仅支持模型仓库。")

        # /solutions 之类的一级路径直接报错
        if len(segments) >= 2 and segments[0] in ("docs", "blog", "tasks", "spaces", "models") and segments[0] != "models":
            if segments[0] == "spaces":
                raise ParseError("暂不支持 Space，请粘贴模型仓库链接。")
        if len(segments) < 2:
            raise ParseError("链接里缺少仓库名，例如 https://huggingface.co/Qwen/Qwen3.5-4B")

        repo_id = f"{segments[0]}/{segments[1]}"
        rest = segments[2:]
        if rest and rest[0] in ("blob", "resolve", "raw"):
            mode = rest[0]
            rest = rest[1:]
            if not rest:
                raise ParseError("链接里缺少版本与文件路径。")
            # revision 可能是 main / refs/pr/N
            if rest[0] == "refs" and len(rest) >= 3:
                revision = "/".join(rest[:3])
                rest = rest[3:]
            else:
                revision = rest[0]
                rest = rest[1:]
            filename = "/".join(rest)
            if mode == "blob" and not filename:
                raise ParseError("链接里缺少文件名。")
        # 其余情况视为仓库首页链接，filename 为空
    elif "@" in raw and _looks_like_repo(raw.split("@")[0]):
        repo_id, _, revision = raw.partition("@")
        repo_id = repo_id.strip()
        revision = revision.strip() or "main"
    elif _looks_like_repo(raw):
        repo_id = re.sub(r"\s+", "", raw)
    else:
        raise ParseError(
            "无法识别的输入格式。\n"
            "支持：仓库短格式（如 Qwen/Qwen3.5-4B）或 huggingface.co / hf-mirror 的仓库、文件链接。"
        )

    repo_id = repo_id.strip("/")
    if not _looks_like_repo(repo_id):
        raise ParseError(f"仓库名格式不正确：“{repo_id}”。应为「组织/仓库名」两段格式。")
    if filename == "/" or filename == ".":
        filename = ""
    filename = filename.strip("/")
    if filename and filename.endswith("/"):
        filename = filename.rstrip("/")

    return ParsedInput(
        repo_id=repo_id,
        revision=revision or "main",
        filename=filename,
        is_file=bool(filename),
        source=raw,
    )


def _looks_like_repo(s: str) -> bool:
    s = s.strip()
    if not _REPO_RE.match(s):
        return False
    org, name = [p.strip() for p in s.split("/", 1)]
    return bool(org) and bool(name)


def to_mirror_url(parsed_or_repo: str, filename: str = "", revision: str = "main", mirror: str = "https://hf-mirror.net") -> str:
    """把仓库/文件转成镜像 resolve 链接（blob 自动转 resolve）。"""
    base = mirror.rstrip("/")
    if filename:
        return f"{base}/{parsed_or_repo}/resolve/{revision}/{filename}"
    return f"{base}/{parsed_or_repo}"
