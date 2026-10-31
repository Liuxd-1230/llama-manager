"""Engine command builders for the three inference engines.

Detection and flag probing go through the config_manager module namespace
(``cfg.detect_server_binary`` etc.) so callers patch the owner of those
functions rather than a copy imported here.
"""
from __future__ import annotations

import shlex
import sys
from pathlib import Path

from . import config_manager as cfg
from .models import AppConfig

IS_WINDOWS = sys.platform == "win32"

# NInfer allocates its KV in fixed 64-token pages; llama-kvmem-server uses
# --kvmem-block-tokens instead, so the rounding unit differs per engine.
KV_PAGE_TOKENS = 64


def _align(value: int, unit: int) -> int:
    """Round a token count down to whole allocation units — the engine's granularity."""
    return max(0, (int(value) // max(1, unit)) * max(1, unit))


class EngineCommandBuilder:
    """Stateless command-line construction; ProcessManager supplies engine dirs."""

    def build_command(self, config: AppConfig) -> list[str]:
        """Build the llama-server / llama-kvmem-server / ninfer-kvmem-server command line from config."""
        if config.engine == "kvmem":
            return self._build_kvmem_command(config)
        if config.engine == "ninfer":
            return self._build_ninfer_command(config)

        server_bin = cfg.detect_server_binary(self._engine_dir(config))

        if not server_bin:
            raise FileNotFoundError(
                f"llama-server not found in {config.llama_cpp_dir}/build/bin/"
            )

        cmd = [server_bin]
        cmd += ["-m", config.model_path]

        if config.mmproj_path:
            cmd += ["--mmproj", config.mmproj_path]
            cmd += ["--mmproj-offload" if config.mmproj_gpu else "--no-mmproj-offload"]

        b = config.basic
        cmd += ["-c", str(b.ctx_size)]
        if b.fit_enabled:
            cmd += ["--fit", "on"]
        elif b.ngl_enabled:
            cmd += ["-ngl", str(b.ngl)]
        else:
            cmd += ["-ngl", "0"]
        cmd += ["-t", str(b.threads)]
        cmd += ["-np", str(b.parallel)]

        # mmap is the engine default; current llama.cpp builds reject a bare
        # --mmap, so only the opt-out needs a flag.
        if not b.mmap:
            cmd.append("--no-mmap")
        if b.mlock:
            cmd.append("--mlock")

        if b.n_cpu_moe > 0:
            cmd += ["--n-cpu-moe", str(b.n_cpu_moe)]

        if b.kv_cache_quant_k:
            cmd += ["--cache-type-k", b.kv_cache_quant_k]
        if b.kv_cache_quant_v:
            cmd += ["--cache-type-v", b.kv_cache_quant_v]

        if b.enable_thinking:
            cmd += ["--reasoning", "on"]

        # KV cache offload to GPU
        if not b.kv_offload:
            cmd.append("--no-kv-offload")

        # Flash attention
        if b.flash_attn:
            cmd += ["--flash-attn", "on"]

        # Target margin for llama.cpp auto-fit.
        if b.fit_enabled and b.fit_target > 0:
            cmd += ["--fit-target", str(b.fit_target)]

        # Unified KV buffer
        if not b.kv_unified:
            cmd.append("--no-kv-unified")

        # Batch sizes
        cmd += ["-b", str(b.batch_size)]
        cmd += ["-ub", str(b.ubatch_size)]

        # Context shift
        if b.context_shift:
            cmd.append("--context-shift")

        # Cache RAM limit
        if b.cache_ram >= 0:
            cmd += ["--cache-ram", str(b.cache_ram)]

        s = config.sampling
        cmd += ["--temp", str(s.temperature)]
        cmd += ["--top-k", str(s.top_k)]
        cmd += ["--top-p", str(s.top_p)]

        if s.min_p_enabled:
            cmd += ["--min-p", str(s.min_p)]
        if s.repeat_penalty_enabled:
            cmd += ["--repeat-penalty", str(s.repeat_penalty)]
        if s.presence_penalty_enabled:
            cmd += ["--presence-penalty", str(s.presence_penalty)]

        srv = config.server
        cmd += ["--host", srv.host, "--port", str(srv.port)]

        if config.chat_template_file.strip():
            cmd += ["--chat-template-file", config.chat_template_file.strip()]

        # MTP speculative decoding
        mtp = config.mtp
        if mtp.enabled:
            cmd += ["--spec-type", mtp.spec_type]
            cmd += ["--spec-draft-n-max", str(mtp.draft_n_max)]
            if mtp.draft_n_min > 0:
                cmd += ["--spec-draft-n-min", str(mtp.draft_n_min)]
            if mtp.p_min != 0.0:
                cmd += ["--spec-draft-p-min", str(mtp.p_min)]
            if mtp.p_split != 0.10:
                cmd += ["--spec-draft-p-split", str(mtp.p_split)]

        if config.extra_params.strip():
            try:
                cmd += shlex.split(config.extra_params, posix=(not IS_WINDOWS))
            except ValueError as e:
                raise ValueError(f"extra_params 语法错误: {e}") from e

        return cmd

    def _build_kvmem_command(self, config: AppConfig) -> list[str]:
        """Build the llama-kvmem-server command line (KV virtualization engine)."""
        k = config.kvmem
        if k.budget + k.gen_reserve > k.workspace:
            raise ValueError(
                f"KVMem: budget({k.budget}) + gen_reserve({k.gen_reserve}) 不能超过 workspace({k.workspace})"
            )

        server_bin = cfg.detect_kvmem_binary(self._engine_dir(config))
        if not server_bin:
            raise FileNotFoundError(
                f"llama-kvmem-server not found in {self._engine_dir(config)}/ (root or bin/)"
            )

        cmd = [server_bin, "-m", config.model_path]
        if config.mmproj_path:
            cmd += ["--mmproj", config.mmproj_path]
            # The projector defaults to system RAM: on the 8GB card its VRAM
            # footprint crowds out decode. --mmproj-offload opts into VRAM.
            cmd += ["--mmproj-offload" if config.mmproj_gpu else "--no-mmproj-offload"]
        if config.basic.ngl_enabled:
            cmd += ["-ngl", str(config.basic.ngl)]
        cmd += ["--host", config.server.host, "--port", str(config.server.port)]
        # In KVMem, -c is the logical KV workspace, not a VRAM cap; VRAM = budget + gen_reserve.
        # No -n here: upstream master treats gen_reserve as append workspace ("not an
        # output limit"); v0.16 clamps output to gen_reserve server-side anyway.
        cmd += ["-c", str(k.workspace), "-b", str(k.batch), "--ubatch-size", str(k.ubatch)]
        cmd += [
            "--kvmem-budget", str(k.budget),
            "--kvmem-gen-reserve", str(k.gen_reserve),
            "--kvmem-block-tokens", str(k.block_tokens),
            "--kvmem-query-policy", k.query_policy,
            "--kvmem-query-replay", "auto",
            "--kv-dtype", k.kv_dtype,
        ]
        # Retrieval: the pinned sink/recent windows are carved out of the same
        # GPU budget, so over-sized windows are a launch failure, not a tuning
        # preference — catch it here where the message can name the fields.
        unit = k.block_tokens
        sink = _align(k.sink_tokens, unit)
        recent = _align(k.recent_tokens, unit)
        if sink + recent > k.budget:
            raise ValueError(
                f"KVMem: 常驻窗口 sink({sink}) + recent({recent}) 对齐到 {unit}-token 块后超过 GPU 预算 {k.budget}"
            )
        if sink > 0:
            cmd += ["--kvmem-sink-tokens", str(sink)]
        if recent > 0:
            cmd += ["--kvmem-recent-tokens", str(recent)]
        scores_lrfu = "--kvmem-lrfu" in cfg.binary_flags(server_bin)
        if k.lrfu and not scores_lrfu:
            raise ValueError(
                f"KVMem: 该二进制不支持 LRFU 历史加权（需 v0.17+ 构建）：{server_bin}。"
                "关闭「历史加权」，或把引擎目录指向内置 KVMem 包。"
            )
        if k.lrfu:
            cmd += [
                "--kvmem-lrfu",
                "--kvmem-lrfu-lambda", str(k.lrfu_lambda),
                "--kvmem-lrfu-top-frac", str(k.lrfu_top_frac),
            ]
        if scores_lrfu:
            cmd += ["--kvmem-score-agg", k.score_agg]

        # Serve the package's built-in WebUI when present (prism/rc packages).
        for base in (Path(server_bin).parent.parent, Path(server_bin).parent):
            ui_dir = base / "share" / "kvmem" / "ui"
            if ui_dir.is_dir():
                cmd += ["--ui-dir", str(ui_dir), "--webui"]
                break
        if config.basic.flash_attn:
            cmd += ["--flash-attn", "on"]
        if k.enable_thinking:
            # reasoning-budget caps THINKING tokens. v0.16 still hard-caps the whole
            # output at gen_reserve server-side, so keep at least 1024 tokens of
            # answer headroom there; on master (no output cap) the clamp is inert.
            thinking_budget = max(0, min(k.reasoning_budget, k.gen_reserve - 1024))
            cmd += ["--enable-thinking", "--reasoning-budget", str(thinking_budget)]
        if config.chat_template_file.strip():
            cmd += ["--chat-template-file", config.chat_template_file.strip()]
        if config.mtp.enabled:
            # Experimental: requires a model with a merged MTP head (prism.3 flow).
            cmd += [
                "--spec-type", "draft-mtp",
                "--spec-draft-n-max", str(max(1, config.mtp.draft_n_max)),
                "--spec-kv-dtype", "f16",
                "--kvmem-mtp-state", k.mtp_state,
            ]
        else:
            cmd += ["--spec-type", "none"]

        if config.extra_params.strip():
            try:
                cmd += shlex.split(config.extra_params, posix=(not IS_WINDOWS))
            except ValueError as e:
                raise ValueError(f"extra_params 语法错误: {e}") from e
        return cmd

    def _build_ninfer_command(self, config: AppConfig) -> list[str]:
        """Build the ninfer-kvmem-server command line (.ninfer artifact engine).

        KVMem v0.18.0 folded the NInfer worker onto the KVMem tiering model, so
        the retrieval vocabulary matches llama-kvmem-server: B/R/H size the
        device and host KV, sink + recent pin the windows inside B, and LRFU
        ranks what is left.
        """
        n = config.ninfer
        server_bin = cfg.detect_ninfer_binary(self._engine_dir(config))
        if not server_bin:
            raise FileNotFoundError(
                f"ninfer-kvmem-server not found in {self._engine_dir(config)}/ (workers/ninfer/ or engine/)"
            )

        budget = _align(n.budget, KV_PAGE_TOKENS)
        reserve = _align(n.gen_reserve, KV_PAGE_TOKENS)
        sink = _align(n.sink_tokens, KV_PAGE_TOKENS)
        recent = max(KV_PAGE_TOKENS, _align(n.recent_tokens, KV_PAGE_TOKENS)) if n.recent_tokens > 0 else 0
        if budget + reserve > n.max_context:
            raise ValueError(
                f"NInfer: GPU 预算({budget}) + 生成预留({reserve}) 超过逻辑上下文({n.max_context})，引擎会拒绝装载"
            )
        if sink + recent > budget:
            raise ValueError(
                f"NInfer: 常驻窗口 sink({sink}) + recent({recent}) 对齐到 64-token 页后超过 GPU 预算({budget})，"
                f"缩小常驻窗口或把预算加大到至少 {sink + recent}"
            )

        cmd = [server_bin, config.model_path]
        cmd += ["--host", config.server.host, "--port", str(config.server.port)]
        cmd += ["--max-context", str(n.max_context)]
        cmd += [
            "--kvmem-budget", str(budget),
            "--kvmem-gen-reserve", str(reserve),
            "--kvmem-host-mib", str(n.host_kv_mib),
            "--kvmem-sessions", str(max(1, min(16, n.sessions))),
        ]
        if sink > 0:
            cmd += ["--kvmem-sink-tokens", str(sink)]
        if recent > 0:
            cmd += ["--kvmem-recent-tokens", str(recent)]
        scores_lrfu = "--kvmem-lrfu" in cfg.binary_flags(server_bin)
        if n.lrfu and not scores_lrfu:
            raise ValueError(
                f"NInfer: 该二进制不支持 LRFU 历史加权（需 KVMem v0.18+ 统一包）：{server_bin}。"
                "关闭「历史加权」，或把引擎目录指向内置引擎包。"
            )
        if n.lrfu:
            cmd += [
                "--kvmem-lrfu",
                "--kvmem-lrfu-lambda", str(n.lrfu_lambda),
                "--kvmem-lrfu-top-frac", str(n.lrfu_top_frac),
            ]
        if scores_lrfu:
            cmd += ["--kvmem-score-agg", n.score_agg]
        cmd += ["--kv-dtype", n.kv_dtype]
        if n.prefill_chunk > 0:
            # Must be a multiple of 128 or the engine refuses to start.
            cmd += ["--prefill-chunk", str(max(128, (n.prefill_chunk // 128) * 128))]
        cmd += ["--max-concurrency", str(max(1, min(8, n.max_concurrency)))]
        if n.default_max_tokens > 0:
            cmd += ["--default-max-tokens", str(n.default_max_tokens)]
        if not n.cuda_graph:
            cmd.append("--no-cuda-graph")
        if n.fast_prefill:
            cmd.append("--fast-prefill-kernel")
        if n.disk_path.strip():
            cmd += ["--kvmem-disk-path", n.disk_path.strip(), "--kvmem-disk-mib", str(n.disk_mib)]
        # Browsers reach the engine cross-origin via the manager-hosted chat page.
        cmd.append("--cors")
        if n.spec != "none":
            cmd += ["--spec", n.spec, "--draft-tokens", str(max(1, min(n.draft_tokens, 15)))]
            if n.adaptive_mtp:
                cmd.append("--adaptive-mtp")
            if n.ngram_draft_tokens > 0:
                cmd += [
                    "--ngram-draft-tokens", str(max(1, min(63, n.ngram_draft_tokens))),
                    "--ngram-min-match", str(max(4, min(64, n.ngram_min_match))),
                ]

        # Server-side sampling defaults; per-request fields override them.
        s = config.sampling
        cmd += ["--temperature", str(s.temperature), "--top-p", str(s.top_p)]
        # The engine only accepts top-k 0..20.
        cmd += ["--top-k", str(max(0, min(s.top_k, 20)))]
        if s.min_p_enabled:
            cmd += ["--min-p", str(s.min_p)]
        if s.presence_penalty_enabled:
            cmd += ["--presence-penalty", str(s.presence_penalty)]

        # Thinking: the shared switch maps onto the reasoning-effort knob.
        cmd += ["--default-reasoning-effort", n.reasoning_effort if config.basic.enable_thinking else "none"]
        if n.default_thinking_budget > 0:
            cmd += ["--default-thinking-budget", str(n.default_thinking_budget)]
        if n.model_id.strip():
            cmd += ["--model-id", n.model_id.strip()]

        if config.extra_params.strip():
            try:
                cmd += shlex.split(config.extra_params, posix=(not IS_WINDOWS))
            except ValueError as e:
                raise ValueError(f"extra_params 语法错误: {e}") from e
        return cmd

