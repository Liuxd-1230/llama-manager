"""离线测试用的 Fake Hugging Face 服务器。

实现 hf_hub_download / list_repo_tree 所需的最小端点子集：
  - HEAD/GET /{repo_id}/resolve/{revision}/{path}   （含 Range 续传）
  - GET    /api/models/{repo_id}/tree/{revision}     （文件列表，支持 expand）
  - 401 门禁模式、一次性 500 故障、断流故障、限速
所有 LFS 内容的 sha256 与其 etag 一致，模拟真实 CDN 行为。
"""

from __future__ import annotations

import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote


class FakeRepo:
    def __init__(self, repo_id: str, revision: str = "main", require_token: bool = False):
        self.repo_id = repo_id
        self.revision = revision
        self.require_token = require_token
        self.commit = hashlib.sha1(repo_id.encode()).hexdigest()
        self.files: dict[str, bytes] = {}
        # 这些路径的 HEAD 响应不带 X-Repo-Commit/ETag（模拟 hf-mirror.net 的 Cloudflare 缓存层）
        self.headerless: set[str] = set()

    def add_file(self, path: str, data: bytes | None = None, size: int = 0) -> bytes:
        if data is None:
            data = (path + str(size)).encode("utf-8") * 1
            data = (data * (size // max(len(data), 1) + 1))[:size] if size else b"content"
        self.files[path] = data
        return data

    def sha256(self, path: str) -> str:
        return hashlib.sha256(self.files[path]).hexdigest()


class FakeHFServer:
    """在 127.0.0.1 随机端口上模拟 HF Hub。"""

    def __init__(self, token: str = "hf_test_token_1234567890"):
        self.repos: dict[tuple[str, str], FakeRepo] = {}
        self.valid_token = token
        # 故障注入计数器：取到 0 之前每次 GET 都注入故障
        self.fail_500 = 0
        self.fail_tree = 0   # >0 时 tree 端点返回 500（模拟 expand 不可用）
        self.fail_revision = 0  # >0 时 model_info 端点返回 500
        self.abort_stream = 0
        self.throttle_seconds = 0.0
        self.request_log: list[tuple[str, str]] = []
        self.range_requests: list[str] = []
        self.ignore_range = False
        self._lock = threading.Lock()

        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # 静默
                pass

            def _token_ok(self) -> bool:
                auth = self.headers.get("Authorization", "")
                return auth == f"Bearer {outer.valid_token}"

            def _route(self):
                parsed = urlparse(self.path)
                parts = [p for p in parsed.path.split("/") if p]
                if len(parts) >= 4 and parts[2] == "resolve":
                    repo_id = "/".join(parts[:2])
                    revision = parts[3]
                    filename = "/".join(parts[4:])
                    return ("resolve", repo_id, revision, unquote(filename))
                if len(parts) >= 6 and parts[0] == "api" and parts[1] == "models" and parts[4] == "tree":
                    repo_id = "/".join(parts[2:4])
                    revision = "/".join(parts[5:])
                    return ("tree", repo_id, revision, None)
                return (None, None, None, None)

            def _repo(self, repo_id: str, revision: str) -> FakeRepo | None:
                return outer.repos.get((repo_id, revision))

            def _send_json(self, code: int, payload: dict, extra: dict | None = None):
                body = json.dumps(payload).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                for k, v in (extra or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            def do_HEAD(self):
                self._handle(head=True)

            def do_GET(self):
                self._handle(head=False)

            def _handle(self, head: bool):
                kind, repo_id, revision, filename = self._route()
                with outer._lock:
                    outer.request_log.append((self.command, self.path))
                path_only = urlparse(self.path).path
                if path_only.startswith("/api/models/") and "/revision/" in path_only:
                    # model_info 端点：/api/models/{repo}/revision/{rev}
                    seg = [p for p in path_only.split("/") if p]
                    rid = "/".join(seg[2:4])
                    rev = "/".join(seg[5:])
                    repo2 = self._repo(rid, rev)
                    if repo2 is None:
                        self._send_json(404, {"error": "Repository not found"})
                        return
                    if outer.fail_revision > 0:
                        outer.fail_revision -= 1
                        self._send_json(500, {"error": "injected revision error"})
                        return
                    siblings = []
                    for p, d in repo2.files.items():
                        sib = {"rfilename": p, "size": len(d), "blobId": hashlib.sha1(p.encode()).hexdigest()}
                        if len(d) > 256:
                            sib["lfs"] = {"size": len(d), "sha256": repo2.sha256(p), "pointerSize": 134}
                        siblings.append(sib)
                    self._send_json(200, {"id": repo2.repo_id, "sha": repo2.commit, "siblings": siblings})
                    return
                if kind == "tree":
                    repo = self._repo(repo_id, revision)
                    if repo is None:
                        self._send_json(404, {"error": "Repository not found"})
                        return
                    q = parse_qs(urlparse(self.path).query)
                    expand = q.get("expand", ["false"])[0] == "true"
                    if outer.fail_tree > 0 and expand:
                        outer.fail_tree -= 1
                        self._send_json(500, {"error": "injected tree error"})
                        return
                    entries = []
                    for path, data in repo.files.items():
                        entry = {
                            "type": "file",
                            "oid": hashlib.sha1(path.encode()).hexdigest(),
                            "size": len(data),
                            "path": path,
                        }
                        if expand and len(data) > 256:
                            entry["lfs"] = {
                                "oid": repo.sha256(path),
                                "size": len(data),
                                "pointerSize": 134,
                            }
                        entries.append(entry)
                    self._send_json(200, entries)
                    return

                if kind != "resolve":
                    self._send_json(404, {"error": "Not found"})
                    return

                repo = self._repo(repo_id, revision)
                if repo is None:
                    self._send_json(404, {"error": f"Repository {repo_id} not found"})
                    return
                if repo.require_token and not self._token_ok():
                    self._send_json(
                        401,
                        {"error": f"Access to model {repo_id} is gated. You must have access to this repo."},
                    )
                    return
                if filename not in repo.files:
                    self._send_json(404, {"error": f"Entry {filename} not found"})
                    return

                data = repo.files[filename]
                etag = repo.sha256(filename)
                headerless = filename in repo.headerless
                common = {
                    "X-Repo-Commit": repo.commit,
                    "ETag": f'"{etag}"',
                    "Accept-Ranges": "bytes",
                    "Content-Type": "application/octet-stream",
                }
                if headerless:
                    common.pop("X-Repo-Commit")
                    common.pop("ETag")

                if head:
                    self.send_response(200)
                    for k, v in common.items():
                        self.send_header(k, v)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    return

                # 故障注入
                with outer._lock:
                    if outer.fail_500 > 0:
                        outer.fail_500 -= 1
                        self._send_json(500, {"error": "injected server error"})
                        return
                    if outer.abort_stream > 0:
                        outer.abort_stream -= 1
                        self.send_response(200)
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        try:
                            self.wfile.write(data[: len(data) // 2])
                            self.wfile.flush()
                        except OSError:
                            pass
                        self.close_connection = True
                        return

                rng = self.headers.get("Range")
                if rng:
                    with outer._lock: outer.range_requests.append(rng)
                if outer.ignore_range:rng=None
                start = 0
                if rng and rng.startswith("bytes="):
                    spec = rng[6:].split(",")[0]
                    start_s = spec.split("-")[0]
                    if start_s:
                        start = int(start_s)
                chunk = data[start:]
                code = 200
                headers = dict(common)
                if start > 0:
                    code = 206
                    headers["Content-Range"] = f"bytes {start}-{len(data) - 1}/{len(data)}"
                body = chunk if not head else b""
                self.send_response(code)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                # 限速：分块写，模拟慢速网络
                piece = 64 * 1024
                for i in range(0, len(body), piece):
                    if outer.throttle_seconds:
                        threading.Event().wait(outer.throttle_seconds)
                    self.wfile.write(body[i : i + piece])

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def endpoint(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def add_repo(self, repo: FakeRepo) -> FakeRepo:
        self.repos[(repo.repo_id, repo.revision)] = repo
        return repo

    def start(self):
        self._thread.start()
        return self

    def stop(self):
        self._server.shutdown()
        self._server.server_close()
