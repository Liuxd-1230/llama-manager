"""缓存目录解析、命令预览、文件分类、格式化、历史的单元测试。"""

import os

from backend.hf_download.core.cache_utils import build_hf_command, find_incomplete_files, resolve_hub_cache_dir
from backend.hf_download.core.formatting import format_eta, human_size, human_speed
from backend.hf_download.core.history import HistoryStore
from backend.hf_download.models import FileCategory, RepoFile


def test_resolve_cache_dir_hf_home_style(tmp_path):
    hub = tmp_path / "hub"
    (hub / "models--org--name").mkdir(parents=True)
    assert resolve_hub_cache_dir(str(tmp_path)) == str(hub)


def test_resolve_cache_dir_hub_cache_style(tmp_path):
    (tmp_path / "models--org--name").mkdir(parents=True)
    assert resolve_hub_cache_dir(str(tmp_path)) == str(tmp_path)


def test_resolve_cache_dir_fresh(tmp_path):
    assert resolve_hub_cache_dir(str(tmp_path)) == str(tmp_path)


def test_build_hf_command_local_dir():
    cmd = build_hf_command(
        "OS-Software/Ternary-Bonsai-2-27B-Uncensored-Heretic-GGUF",
        patterns=["*PTQ1_0.gguf"],
        mode="local_dir",
        local_dir=r"E:\LmModels\Bonsai",
    )
    assert cmd == (
        'hf download OS-Software/Ternary-Bonsai-2-27B-Uncensored-Heretic-GGUF '
        '--include "*PTQ1_0.gguf" --local-dir "E:\\LmModels\\Bonsai"'
    )


def test_build_hf_command_cache_dir_with_revision():
    cmd = build_hf_command("org/repo", revision="dev", mode="cache", cache_dir=r"E:\hf")
    assert cmd == 'hf download org/repo --revision dev --cache-dir "E:\\hf"'


def test_find_incomplete_files(tmp_path):
    cache = tmp_path / "cache"
    blob_dir = cache / "models--o--r" / "blobs"
    blob_dir.mkdir(parents=True)
    inc = blob_dir / "abc.incomplete"
    inc.write_bytes(b"x" * 100)
    local = tmp_path / "local"
    dl = local / ".cache" / "huggingface" / "download"
    dl.mkdir(parents=True)
    (dl / "m.incomplete").write_bytes(b"y" * 10)
    found = find_incomplete_files(str(cache), [str(local)])
    assert len(found) == 2


def test_file_category():
    assert FileCategory.of("model.gguf") == FileCategory.GGUF
    assert FileCategory.of("sub/dir/weights.safetensors") == FileCategory.SAFETENSORS
    assert FileCategory.of("x.litertlm") == FileCategory.LITERT
    assert FileCategory.of("bundle.zip") == FileCategory.ZIP
    assert FileCategory.of("config.json") == FileCategory.CONFIG
    assert FileCategory.of("tokenizer.yaml") == FileCategory.CONFIG
    assert FileCategory.of("unknown.bin") == FileCategory.OTHER


def test_repo_file_helpers():
    f = RepoFile(path="onnx/model_q4.onnx", size=1024)
    assert f.name == "model_q4.onnx"
    assert f.size == 1024


def test_human_size():
    assert human_size(0) == "0 B"
    assert human_size(1024) == "1.0 KB"
    assert human_size(17.4 * 1024**3).endswith("GB")
    assert human_size(None) == "—"


def test_speed_and_eta():
    assert human_speed(0) == "—"
    assert "MB/s" in human_speed(5 * 1024**2)
    assert format_eta(None) == "—"
    assert format_eta(75) == "01:15"
    assert "小时" in format_eta(3600 * 2 + 60)


def test_history_store(tmp_path):
    db = tmp_path / "hist.db"
    store = HistoryStore(db)
    store.add("org/repo", "main", "a.gguf", 123, r"E:\x\a.gguf", "https://hf-mirror.net", "local_dir", "completed")
    store.add("org/repo", "main", "b.gguf", 456, "", "https://hf-mirror.net", "local_dir", "failed", error="网络")
    rows = store.query()
    assert len(rows) == 2
    assert rows[0]["filename"] == "b.gguf"  # 最新的在前
    assert rows[1]["status"] == "completed"
    assert rows[1]["local_path"] == r"E:\x\a.gguf"
    # 关键字过滤
    assert len(store.query("a.gguf")) == 1
    store.clear()
    assert store.query() == []
