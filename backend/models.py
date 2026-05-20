"""Pydantic data models for llama.cpp Run Manager."""
from __future__ import annotations
from pydantic import BaseModel, Field
from typing import Optional


class BasicSettings(BaseModel):
    ctx_size: int = 4096
    ngl: int = 99
    threads: int = 8
    parallel: int = 1
    mmap: bool = True
    mlock: bool = False  # lock model in RAM, prevent swapping
    n_cpu_moe: int = 0  # 0=disabled, >0 = number of MoE expert layers to offload to CPU
    kv_cache_quant_k: str = ""  # e.g. "q8_0", "q4_0", empty = default
    kv_cache_quant_v: str = ""  # separate K and V quant
    enable_thinking: bool = False
    kv_offload: bool = True  # KV cache offload to GPU (--no-kv-offload to disable)
    flash_attn: bool = False  # Flash Attention
    fit_target: int = 0  # --fit-target: fit model to GPU with margin in MiB (0=off)
    kv_unified: bool = True  # unified KV buffer shared across all sequences (--kv-unified)
    batch_size: int = 2048  # logical max batch size (-b)
    ubatch_size: int = 512  # physical max batch size (-ub)
    context_shift: bool = False  # auto context shift on infinite generation
    cache_ram: int = -1  # max cache size in MiB (-cram, -1=no limit, 0=disable)


class SamplingSettings(BaseModel):
    temperature: float = 0.7
    top_k: int = 40
    top_p: float = 0.95
    min_p_enabled: bool = False
    min_p: float = 0.05
    repeat_penalty_enabled: bool = False
    repeat_penalty: float = 1.1
    presence_penalty_enabled: bool = False
    presence_penalty: float = 0.0


class MTPSettings(BaseModel):
    enabled: bool = False
    spec_type: str = "draft-mtp"  # draft-mtp
    draft_n_max: int = 3  # max draft tokens (2 or 3 typical)
    draft_n_min: int = 0  # min draft tokens (default: 0)
    p_min: float = 0.0  # draft confidence threshold: 0.0 = collect all drafts (faster), higher = stop drafting sooner
    p_split: float = 0.10  # split probability threshold


class ServerSettings(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8080
    mode: str = "local"  # "local" or "lan"


class CompileSettings(BaseModel):
    command: str = 'cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="89" && cmake --build build --config Release -j12'


class AppConfig(BaseModel):
    llama_cpp_dir: str = ""
    model_path: str = ""
    mmproj_path: str = ""
    basic: BasicSettings = Field(default_factory=BasicSettings)
    sampling: SamplingSettings = Field(default_factory=SamplingSettings)
    mtp: MTPSettings = Field(default_factory=MTPSettings)
    system_prompt: str = ""
    extra_params: str = ""
    server: ServerSettings = Field(default_factory=ServerSettings)
    compile: CompileSettings = Field(default_factory=CompileSettings)


class ModelInfo(BaseModel):
    name: str
    path: str
    size_mb: float


class DirEntry(BaseModel):
    name: str
    path: str
    is_dir: bool
    size_mb: float = 0


class ServerStatus(BaseModel):
    state: str = "stopped"  # stopped, starting, running, error
    pid: Optional[int] = None
    uptime_seconds: float = 0
    error: Optional[str] = None


class UpdateStatus(BaseModel):
    has_update: bool = False
    current_commit: str = ""
    remote_commit: str = ""
    is_compiling: bool = False
    compile_output: str = ""
