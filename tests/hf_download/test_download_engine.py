"""下载引擎端到端测试：跑在 Fake HF 服务器上，无需真实网络。

覆盖：文件列表、缓存模式、local_dir 模式、断点续传（暂停→恢复）、
取消、失败自动重试、401 门禁的友好错误与 Token 重试。
"""

import hashlib
import os
import time

import pytest

from backend.hf_download.core.download_engine import DownloadEngine
from backend.hf_download.core.hf_client import list_repo_files_full
from backend.hf_download.models import BatchSpec, RepoFile, TaskState
from .fake_hf_server import FakeHFServer, FakeRepo


@pytest.fixture
def server():
    srv = FakeHFServer().start()
    yield srv
    srv.stop()


@pytest.fixture
def repo(server):
    repo = server.add_repo(FakeRepo("e2e-org/e2e-model"))
    repo.add_file("config.json", b'{"model_type": "test"}', )
    repo.add_file("weights/medium.gguf", os.urandom(4 * 1024 * 1024))
    repo.add_file("big.bin", os.urandom(9 * 1024 * 1024))
    return repo


def wait_for(engine, cond, timeout=30.0, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        snaps = engine.snapshot()
        if cond(snaps):
            return snaps
        time.sleep(interval)
    snaps = engine.snapshot()
    raise AssertionError(f"等待超时，当前状态: {[(s['filename'], s['state'].value, s['error'][:80]) for s in snaps]}")


def submit(engine, repo, files, mode="cache", cache_dir=None, local_dir=None):
    spec = BatchSpec(
        repo_id=repo.repo_id,
        revision=repo.revision,
        files=files,
        mode=mode,
        cache_dir=str(cache_dir),
        local_dir=str(local_dir),
        endpoint=server_endpoint,
    )
    return engine.submit(spec)


def make_engine(tmp_path, token=None, retries=3, workers=4):
    history = __import__("backend.hf_download.core.history", fromlist=["HistoryStore"]).HistoryStore(tmp_path / "hist.db")
    return DownloadEngine(
        token_provider=lambda: token,
        history=history,
        max_workers=workers,
        max_retries=retries,
        retry_base_delay=0.2,
    )


server_endpoint = ""  # 由 fixture 动态填充


@pytest.fixture(autouse=True)
def _endpoint(server):
    global server_endpoint
    server_endpoint = server.endpoint
    yield
    server_endpoint = ""


# ---------------------------------------------------------------- 列表


def test_list_repo_files_full(server, repo):
    files = list_repo_files_full(server.endpoint, repo.repo_id, "main")
    names = {f.path for f in files}
    assert names == {"config.json", "weights/medium.gguf", "big.bin"}
    sizes = {f.path: f.size for f in files}
    assert sizes["config.json"] == len(b'{"model_type": "test"}')
    assert sizes["big.bin"] == 9 * 1024 * 1024


def test_list_repo_files_not_found(server):
    from backend.hf_download.core.errors import translate_exception

    try:
        list_repo_files_full(server.endpoint, "nope/nope", "main")
        raise AssertionError("应当抛出异常")
    except Exception as exc:
        fe = translate_exception(exc)
        assert fe.kind == "notfound"


# ---------------------------------------------------------------- 缓存模式


def test_download_cache_mode(server, repo, tmp_path):
    engine = make_engine(tmp_path)
    cache = tmp_path / "cache"
    files = [RepoFile(path="config.json", size=len(repo.files["config.json"]))]
    batch = submit(engine, repo, files, cache_dir=cache)

    snaps = wait_for(engine, lambda s: all(t["state"] is TaskState.COMPLETED for t in s))
    assert snaps[0]["local_path"], "应有实际文件路径"
    p = snaps[0]["local_path"]
    assert os.path.isfile(p)
    # snapshot 路径应形如 .../snapshots/<commit>/config.json（不是 blobs sha 文件名）
    assert "snapshots" in p and p.endswith("config.json")
    from pathlib import Path as _P
    assert _P(p).parent.name == repo.commit
    with open(p, "rb") as fh:
        assert fh.read() == repo.files["config.json"]
    # blobs 中应存在 sha256 命名的实体文件
    sha = hashlib.sha256(repo.files["config.json"]).hexdigest()
    assert (cache / f"models--e2e-org--e2e-model" / "blobs" / sha).is_file()
    # refs/main 记录 commit
    refs = cache / "models--e2e-org--e2e-model" / "refs" / "main"
    assert refs.read_text().strip() == repo.commit
    # 历史已记录
    summary = engine.batch_summary(batch)
    assert summary["done_count"] == 1 and summary["failed_count"] == 0


def test_download_local_dir_mode(server, repo, tmp_path):
    engine = make_engine(tmp_path)
    target = tmp_path / "LmModels"
    files = [
        RepoFile(path="weights/medium.gguf", size=len(repo.files["weights/medium.gguf"])),
        RepoFile(path="big.bin", size=len(repo.files["big.bin"])),
    ]
    submit(engine, repo, files, mode="local_dir", local_dir=target)

    snaps = wait_for(engine, lambda s: all(t["state"] is TaskState.COMPLETED for t in s))
    for s in snaps:
        assert os.path.isfile(s["local_path"])
        assert s["local_path"].startswith(str(target))
    with open(target / "weights" / "medium.gguf", "rb") as fh:
        assert fh.read() == repo.files["weights/medium.gguf"]


# ---------------------------------------------------------------- 暂停 / 恢复（断点续传）


def test_pause_resume_keeps_partial_file(server, repo, tmp_path):
    engine = make_engine(tmp_path)
    target = tmp_path / "LmModels"
    files = [RepoFile(path="big.bin", size=len(repo.files["big.bin"]))]
    server.throttle_seconds = 0.004  # 限速，保证能在下载中途暂停
    try:
        submit(engine, repo, files, mode="local_dir", local_dir=target)
        tid = engine.snapshot()[0]["task_id"]

        wait_for(engine, lambda s: s[0]["bytes_done"] >= 512 * 1024, interval=0.01)
        engine.pause(tid)
        wait_for(engine, lambda s: s[0]["state"] is TaskState.PAUSED, interval=0.01)

        # .incomplete 文件应保留，且尚未下载完
        incomplete = list((target / ".cache").rglob("*.incomplete"))
        assert incomplete and incomplete[0].stat().st_size > 0, "暂停后应保留未完成临时文件"
        assert incomplete[0].stat().st_size < len(repo.files["big.bin"]), "尚未下载完成"
    finally:
        server.throttle_seconds = 0.0

    engine.resume(tid)
    resumed=wait_for(engine, lambda s: s[0]["state"] is TaskState.COMPLETED)
    assert resumed[0]['http_status']==206
    assert resumed[0]['resumed_from']>0
    assert server.range_requests
    with open(target / "big.bin", "rb") as fh:
        assert fh.read() == repo.files["big.bin"], "断点续传后内容必须完整一致"


def test_resume_after_kill(tmp_path, monkeypatch):
    """进程“重启”后续传：新建引擎实例（模拟重启）继续下载同一文件。"""
    server = FakeHFServer().start()
    try:
        repo = FakeRepo("k-org/k-model")
        data = os.urandom(6 * 1024 * 1024)
        repo.add_file("huge.bin", data)
        server.add_repo(repo)

        target = tmp_path / "LmModels"
        files = [RepoFile(path="huge.bin", size=len(data))]

        def submit_to(engine):
            return engine.submit(
                BatchSpec(repo_id=repo.repo_id, revision="main", files=files,
                          mode="local_dir", local_dir=str(target), endpoint=server.endpoint)
            )

        server.throttle_seconds = 0.004  # 限速以便在中途暂停
        engine1 = DownloadEngine(lambda: None, max_workers=1, max_retries=0, retry_base_delay=0.1)
        batch1 = submit_to(engine1)
        tid = engine1.snapshot()[0]["task_id"]
        wait_for(engine1, lambda s: s[0]["bytes_done"] >= 1024 * 1024, interval=0.01)
        engine1.pause(tid)
        wait_for(engine1, lambda s: s[0]["state"] is TaskState.PAUSED, interval=0.01)
        server.throttle_seconds = 0.0

        # 模拟重启：全新引擎 + 全新 HistoryStore，恢复同一 local_dir
        engine2 = DownloadEngine(lambda: None, max_workers=1, max_retries=0, retry_base_delay=0.1)
        batch2 = submit_to(engine2)
        recovered=wait_for(engine2, lambda s: all(t["state"] is TaskState.COMPLETED for t in s))
        assert recovered[0]["http_status"]==206
        assert recovered[0]["resumed_from"]>0
        with open(target / "huge.bin", "rb") as fh:
            assert fh.read() == data
    finally:
        server.stop()


# ---------------------------------------------------------------- 取消 / 重试


def test_cancel(server, repo, tmp_path):
    server.throttle_seconds = 0.02
    try:
        engine = make_engine(tmp_path)
        target = tmp_path / "LmModels"
        files = [RepoFile(path="big.bin", size=len(repo.files["big.bin"]))]
        submit(engine, repo, files, mode="local_dir", local_dir=target)
        tid = engine.snapshot()[0]["task_id"]
        wait_for(engine, lambda s: s[0]["bytes_done"] > 0)
        engine.cancel(tid)
        snaps = wait_for(engine, lambda s: s[0]["state"] is TaskState.CANCELLED)
        assert snaps[0]["state"] is TaskState.CANCELLED
    finally:
        server.throttle_seconds = 0.0


def test_retry_on_server_error(server, repo, tmp_path):
    engine = make_engine(tmp_path, retries=3)
    target = tmp_path / "LmModels"
    server.fail_500 = 2  # 前两次 GET 注入 500
    try:
        files = [RepoFile(path="config.json", size=len(repo.files["config.json"]))]
        submit(engine, repo, files, mode="local_dir", local_dir=target)
        snaps = wait_for(engine, lambda s: all(t["state"] is TaskState.COMPLETED for t in s))
        assert snaps[0]["attempts"] >= 3, f"应自动重试，实际 attempts={snaps[0]['attempts']}"
    finally:
        server.fail_500 = 0


def test_retry_on_aborted_stream(server, repo, tmp_path):
    engine = make_engine(tmp_path, retries=3)
    target = tmp_path / "LmModels"
    server.abort_stream = 1  # 传输中途断流一次
    files = [RepoFile(path="big.bin", size=len(repo.files["big.bin"]))]
    submit(engine, repo, files, mode="local_dir", local_dir=target)
    wait_for(engine, lambda s: all(t["state"] is TaskState.COMPLETED for t in s))
    with open(target / "big.bin", "rb") as fh:
        assert fh.read() == repo.files["big.bin"]


# ---------------------------------------------------------------- 门禁 / Token


def test_gated_repo_friendly_error_and_token_retry(server, tmp_path):
    repo = FakeRepo("gated-org/gated-model", require_token=True)
    repo.add_file("config.json", b"{}")
    server.add_repo(repo)

    holder = {"token": None}
    history = __import__("backend.hf_download.core.history", fromlist=["HistoryStore"]).HistoryStore(tmp_path / "h.db")
    engine = DownloadEngine(lambda: holder["token"], history=history, max_retries=0, retry_base_delay=0.1)
    target = tmp_path / "out"
    files = [RepoFile(path="config.json", size=2)]
    engine.submit(
        BatchSpec(repo_id=repo.repo_id, revision="main", files=files,
                  mode="local_dir", local_dir=str(target), endpoint=server.endpoint)
    )
    snaps = wait_for(engine, lambda s: s[0]["state"] is TaskState.FAILED)
    assert snaps[0]["error_kind"] == "auth"
    assert "Token" in snaps[0]["error"] and "许可" in snaps[0]["error"]

    # 用户填好 Token 后重试 → 成功
    holder["token"] = server.valid_token
    engine.retry(snaps[0]["task_id"])
    wait_for(engine, lambda s: s[0]["state"] is TaskState.COMPLETED)
    assert (target / "config.json").read_bytes() == b"{}"


def test_concurrency_limit(server, tmp_path):
    repo2 = FakeRepo("c-org/c-model")
    for i in range(4):
        repo2.add_file(f"f{i}.bin", os.urandom(2 * 1024 * 1024))
    server.add_repo(repo2)
    server.throttle_seconds = 0.05
    try:
        engine = make_engine(tmp_path, workers=2)
        target = tmp_path / "out"
        files = [RepoFile(path=f"f{i}.bin", size=len(repo2.files[f"f{i}.bin"])) for i in range(4)]
        engine.submit(
            BatchSpec(repo_id=repo2.repo_id, revision="main", files=files,
                      mode="local_dir", local_dir=str(target), endpoint=server.endpoint)
        )
        # 观察一段时间，下载中数量不应超过 2
        peak = 0
        deadline = time.time() + 3
        while time.time() < deadline and not engine.all_tasks_finished(engine.snapshot()[0]["batch_id"]):
            active = sum(1 for s in engine.snapshot() if s["state"] is TaskState.DOWNLOADING)
            peak = max(peak, active)
            time.sleep(0.03)
        assert peak <= 2
        wait_for(engine, lambda s: all(t["state"] is TaskState.COMPLETED for t in s))
    finally:
        server.throttle_seconds = 0.0


# ---------------------------------------------------------------- 镜像头缺失降级下载


def test_fallback_download_headerless(server, repo, tmp_path):
    """镜像 HEAD 响应缺少 X-Repo-Commit 时，引擎应自动降级为自研 HTTP 下载。"""
    repo.headerless = {"weights/medium.gguf", "config.json"}
    engine = make_engine(tmp_path)
    cache = tmp_path / "cache"
    config_data=repo.files['config.json']
    config_oid=hashlib.sha1(f'blob {len(config_data)}\0'.encode()+config_data).hexdigest()
    files = [
        RepoFile(path="config.json", size=len(repo.files["config.json"]),
                 oid=config_oid),
        RepoFile(path="weights/medium.gguf", size=len(repo.files["weights/medium.gguf"]),
                 lfs_sha256=repo.sha256("weights/medium.gguf")),
    ]
    submit(engine, repo, files, cache_dir=cache)
    snaps = wait_for(engine, lambda s: all(t["state"] is TaskState.COMPLETED for t in s))
    for s in snaps:
        p = s["local_path"]
        assert p and os.path.isfile(p), s
        assert "snapshots" in p
        with open(p, "rb") as fh:
            assert fh.read() == repo.files[s["filename"]], f"内容不一致: {s['filename']}"
    # blob 应以 sha256 / git oid 命名
    blobs = cache / "models--e2e-org--e2e-model" / "blobs"
    assert (blobs / repo.sha256("weights/medium.gguf")).is_file()
    assert (blobs / config_oid).is_file()
    # refs/main 指向 commit
    refs = cache / "models--e2e-org--e2e-model" / "refs" / "main"
    assert refs.read_text().strip() == repo.commit


def test_fallback_download_local_dir(server, repo, tmp_path):
    repo.headerless = {"big.bin"}
    engine = make_engine(tmp_path)
    target = tmp_path / "out"
    files = [RepoFile(path="big.bin", size=len(repo.files["big.bin"]),
                      lfs_sha256=repo.sha256("big.bin"))]
    submit(engine, repo, files, mode="local_dir", local_dir=target)
    wait_for(engine, lambda s: all(t["state"] is TaskState.COMPLETED for t in s))
    assert (target / "big.bin").read_bytes() == repo.files["big.bin"]


# ---------------------------------------------------------------- 列表降级链


def test_list_falls_back_to_model_info_when_tree_fails(server, repo):
    """tree(expand) 不可用时，应经 model_info 仍拿到文件大小。"""
    server.fail_tree = 99
    try:
        files = list_repo_files_full(server.endpoint, repo.repo_id, "main")
    finally:
        server.fail_tree = 0
    sizes = {f.path: f.size for f in files}
    assert sizes["big.bin"] == 9 * 1024 * 1024
    assert sizes["config.json"] == len(b'{"model_type": "test"}')


def test_list_names_only_when_all_size_sources_fail(server, repo):
    """tree 与 model_info 都失败时，退回仅文件名（大小为 None）。"""
    server.fail_tree = 99
    server.fail_revision = 99
    try:
        files = list_repo_files_full(server.endpoint, repo.repo_id, "main")
    finally:
        server.fail_tree = 0
        server.fail_revision = 0
    assert {f.path for f in files} == {"config.json", "weights/medium.gguf", "big.bin"}
    assert all(f.size is None for f in files)


def test_source_ignores_range_restarts_with_explicit_notice(server, repo, tmp_path):
    server.throttle_seconds=.006
    engine=make_engine(tmp_path,workers=1)
    files=[RepoFile('big.bin',size=len(repo.files['big.bin']))]
    try:
        submit(engine,repo,files,mode='local_dir',local_dir=tmp_path/'files')
        tid=engine.snapshot()[0]['task_id']
        wait_for(engine,lambda s:s[0]['bytes_done']>=524288)
        engine.pause(tid);wait_for(engine,lambda s:s[0]['state'] is TaskState.PAUSED)
        server.ignore_range=True;server.throttle_seconds=0
        engine.resume(tid)
        result=wait_for(engine,lambda s:s[0]['state'] is TaskState.COMPLETED)[0]
        assert result['range_supported'] is False
        assert '从头' in result['note']
        assert (tmp_path/'files'/'big.bin').read_bytes()==repo.files['big.bin']
    finally:engine.shutdown()


def test_pinned_version_change_is_not_appended_to_partial(server, repo, tmp_path):
    original=repo.files['big.bin']
    pinned=hashlib.sha256(original).hexdigest()
    repo.add_file('big.bin',b'changed version')
    engine=make_engine(tmp_path,retries=0)
    try:
        submit(engine,repo,[RepoFile('big.bin',size=len(original),is_lfs=True,lfs_sha256=pinned)],mode='local_dir',local_dir=tmp_path/'changed')
        result=wait_for(engine,lambda s:s[0]['state'] is TaskState.FAILED)[0]
        assert '版本已改变' in result['error']
        assert not (tmp_path/'changed'/'big.bin').exists()
    finally:engine.shutdown()


def test_cancel_queued_file_prevents_later_connection(server, repo, tmp_path):
    server.throttle_seconds=.01
    engine=make_engine(tmp_path,workers=1)
    try:
        submit(engine,repo,[RepoFile('big.bin',size=len(repo.files['big.bin'])),RepoFile('config.json',size=len(repo.files['config.json']))],mode='local_dir',local_dir=tmp_path/'queued')
        wait_for(engine,lambda s:any(t['bytes_done']>0 for t in s))
        queued=next(t for t in engine.snapshot() if t['filename']=='config.json')
        engine.cancel(queued['task_id'])
        engine.cancel(next(t['task_id'] for t in engine.snapshot() if t['filename']=='big.bin'))
        wait_for(engine,lambda s:all(t['state'] is TaskState.CANCELLED for t in s))
        assert not (tmp_path/'queued'/'config.json').exists()
        assert all(t['worker_pid'] is None for t in engine.snapshot())
    finally:engine.shutdown()
