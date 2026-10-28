"""URL 解析单元测试（覆盖规格说明中的全部输入形式）。"""

import pytest

from backend.hf_download.core.url_parser import ParseError, parse_input, to_mirror_url


def test_official_repo_url():
    p = parse_input("https://huggingface.co/Qwen/Qwen3.5-4B")
    assert p.repo_id == "Qwen/Qwen3.5-4B"
    assert p.revision == "main"
    assert p.filename == ""
    assert not p.is_file


def test_short_repo_format():
    p = parse_input("Qwen/Qwen3.5-4B")
    assert p.repo_id == "Qwen/Qwen3.5-4B"
    assert p.revision == "main"
    assert not p.is_file


def test_short_repo_with_spaces():
    p = parse_input("  OS-Software/Ternary-Bonsai-2-27B-Uncensored-Heretic-GGUF \n")
    assert p.repo_id == "OS-Software/Ternary-Bonsai-2-27B-Uncensored-Heretic-GGUF"


def test_blob_file_url():
    p = parse_input("https://huggingface.co/org/repo/blob/main/model.gguf")
    assert p.repo_id == "org/repo"
    assert p.revision == "main"
    assert p.filename == "model.gguf"
    assert p.is_file


def test_resolve_file_url():
    p = parse_input("https://huggingface.co/org/repo/resolve/main/sub/dir/model.gguf?download=true")
    assert p.repo_id == "org/repo"
    assert p.filename == "sub/dir/model.gguf"
    assert p.is_file


def test_mirror_url():
    p = parse_input("https://hf-mirror.net/org/repo/blob/main/model-Q4_K_M.gguf")
    assert p.repo_id == "org/repo"
    assert p.filename == "model-Q4_K_M.gguf"


def test_repo_at_revision():
    p = parse_input("org/repo@v1.2.0")
    assert p.repo_id == "org/repo"
    assert p.revision == "v1.2.0"


def test_url_with_refs_pr():
    p = parse_input("https://huggingface.co/org/repo/resolve/refs/pr/3/model.safetensors")
    assert p.revision == "refs/pr/3"
    assert p.filename == "model.safetensors"


def test_url_encoded_filename():
    p = parse_input("https://huggingface.co/org/repo/blob/main/my%20model.gguf")
    assert p.filename == "my model.gguf"


def test_dataset_rejected():
    with pytest.raises(ParseError):
        parse_input("https://huggingface.co/datasets/squad/plain_text")


def test_invalid_input():
    for bad in ["", "hello world", "https://example.com/foo"]:
        with pytest.raises(ParseError):
            parse_input(bad)


def test_single_segment_rejected():
    with pytest.raises(ParseError):
        parse_input("justonefile.gguf")


def test_to_mirror_url():
    assert (
        to_mirror_url("org/repo", "model.gguf")
        == "https://hf-mirror.net/org/repo/resolve/main/model.gguf"
    )
    assert to_mirror_url("org/repo") == "https://hf-mirror.net/org/repo"
