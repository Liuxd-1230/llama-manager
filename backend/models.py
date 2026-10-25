"""Pydantic data models for llama.cpp Run Manager."""
from __future__ import annotations
from pydantic import BaseModel, Field
from typing import Optional


class BasicSettings(BaseModel):
    ctx_size: int = 4096
    ngl_enabled: bool = True  # toggle for -ngl (GPU layer offload)
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
    fit_enabled: bool = False  # toggle for --fit-target
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
    command: str = 'cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="89" && cmake --build build --config Release --target llama-server -j12'


class KvmemSettings(BaseModel):
    """KVMem engine (llama-kvmem-server) — KV cache virtualization parameters.

    Note: workspace (-c) is the logical KV workspace, NOT the VRAM cap;
    VRAM is driven by budget + gen_reserve.

    sink/recent exist since v0.16; lrfu/score_agg need a v0.17+ build and are
    gated by the binary capability probe, so the defaults keep older packages
    launching unchanged.
    """
    workspace: int = 131072  # logical KV workspace tokens (-c)
    budget: int = 24576  # GPU-resident history tokens (--kvmem-budget)
    gen_reserve: int = 10240  # GPU slots reserved for new tokens (--kvmem-gen-reserve, also -n)
    block_tokens: int = 128  # KV block size (--kvmem-block-tokens)
    batch: int = 512  # logical batch (-b)
    ubatch: int = 128  # physical microbatch (--ubatch-size)
    kv_dtype: str = "q4_0"  # --kv-dtype
    query_policy: str = "user"  # --kvmem-query-policy
    mtp_state: str = "snapshots"  # --kvmem-mtp-state; "replay" needs a v0.17+ build (prism.3 prebuilt only supports snapshots)
    enable_thinking: bool = False  # --enable-thinking
    reasoning_budget: int = 4096  # --reasoning-budget
    sink_tokens: int = 0  # always-kept prefix (--kvmem-sink-tokens); 0 = engine default of one block
    recent_tokens: int = 0  # always-kept newest suffix (--kvmem-recent-tokens); 0 = engine default
    lrfu: bool = False  # --kvmem-lrfu: rank blocks by decayed retrieval history
    lrfu_lambda: float = 0.5  # --kvmem-lrfu-lambda: history decay [0,1]
    lrfu_top_frac: float = 0.9  # --kvmem-lrfu-top-frac: hit fraction (0,1], NOT a KV keep ratio
    score_agg: str = "mean"  # --kvmem-score-agg: mean | max across GQA heads


class NinferSettings(BaseModel):
    """NInfer engine (ninfer-kvmem-server, KVMem v0.18.0+) — .ninfer artifacts
    with KVMem RAM/SSD tiering, LRFU retrieval and MTP/ngram speculation.

    Retrieval sizing: B (--kvmem-budget) + R (--kvmem-gen-reserve) are the
    device-resident tokens and drive VRAM; H (--kvmem-host-mib) is the pinned
    host payload quota. sink + recent must fit inside B after rounding to whole
    64-token pages, and R must cover the draft widths. Defaults here are the
    8 GB laptop safe set, not the release recipe's 16 GB table.
    """
    max_context: int = 204800  # logical context ceiling per request (--max-context)
    budget: int = 8192  # selected history B, aligned to 64 (--kvmem-budget)
    gen_reserve: int = 8192  # append workspace R, aligned to 64 (--kvmem-gen-reserve)
    host_kv_mib: int = 4096  # pinned host KV payload budget H (--kvmem-host-mib)
    kv_dtype: str = "k8v4"  # --kv-dtype (delivery dtype; small-pool verdicts are k8v4-only)
    prefill_chunk: int = 256  # tokens per prefill chunk, multiple of 128 (0 = engine default)
    spec: str = "mtp"  # --spec: none | mtp | dflash | dflash2
    draft_tokens: int = 4  # --draft-tokens 1..15
    adaptive_mtp: bool = True  # --adaptive-mtp: verify 3..--draft-tokens per round
    ngram_draft_tokens: int = 31  # --ngram-draft-tokens 1..63 (0 = off; needs --spec)
    ngram_min_match: int = 12  # --ngram-min-match 4..64
    max_concurrency: int = 1  # requests decoded together, 1..8
    default_max_tokens: int = 16384  # output limit when a request sets none
    cuda_graph: bool = False  # False emits --no-cuda-graph (needed on 8 GB)
    sink_tokens: int = 4096  # always-kept prefix (--kvmem-sink-tokens); must fit in budget
    recent_tokens: int = 1024  # always-kept newest suffix (--kvmem-recent-tokens); min 64
    sessions: int = 1  # retained host histories (--kvmem-sessions), 1..16
    lrfu: bool = True  # --kvmem-lrfu
    lrfu_lambda: float = 0.5  # --kvmem-lrfu-lambda [0,1]
    lrfu_top_frac: float = 0.9  # --kvmem-lrfu-top-frac (0,1]
    score_agg: str = "max"  # --kvmem-score-agg: mean | max across GQA heads
    fast_prefill: bool = False  # --fast-prefill-kernel (int8/rk* KV only)
    disk_path: str = ""  # --kvmem-disk-path: RAM/SSD tier spill dir, empty = off
    disk_mib: int = 4096  # --kvmem-disk-mib shared SSD payload quota
    default_thinking_budget: int = 0  # --default-thinking-budget, 0 = engine default
    reasoning_effort: str = "medium"  # --default-reasoning-effort when thinking is on
    model_id: str = ""  # --model-id override; empty = artifact metadata name



ENGINES = ("llama.cpp", "kvmem", "ninfer")


class AppConfig(BaseModel):
    llama_cpp_dir: str = ""
    model_path: str = ""
    mmproj_path: str = ""
    chat_template_file: str = ""  # optional --chat-template-file for both engines
    mmproj_gpu: bool = False  # offload the vision projector to VRAM (default: keep in RAM)
    engine: str = "llama.cpp"  # "llama.cpp" | "kvmem" | "ninfer"
    basic: BasicSettings = Field(default_factory=BasicSettings)
    sampling: SamplingSettings = Field(default_factory=SamplingSettings)
    mtp: MTPSettings = Field(default_factory=MTPSettings)
    kvmem: KvmemSettings = Field(default_factory=KvmemSettings)
    ninfer: NinferSettings = Field(default_factory=NinferSettings)
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
    profile: str = ""  # name of the model profile the running server was launched from


class UpdateStatus(BaseModel):
    has_update: bool = False
    current_commit: str = ""
    remote_commit: str = ""
    is_compiling: bool = False
    compile_output: str = ""
