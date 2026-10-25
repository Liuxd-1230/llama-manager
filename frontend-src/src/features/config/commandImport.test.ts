import { describe, expect, it } from 'vitest'
import { applyLaunchCommand, tokenizeCommand } from './commandImport'
import { defaultConfig } from '../../types'

describe('tokenizeCommand', () => {
  it('keeps quoted spans as single tokens', () => {
    expect(tokenizeCommand('exe -m "E:\\My Models\\a.gguf" -c 4096')).toEqual(['exe', '-m', 'E:\\My Models\\a.gguf', '-c', '4096'])
  })
})

describe('applyLaunchCommand', () => {
  it('parses the full llama-server example command', () => {
    const text = [
      '.\\llama-server.exe',
      '-m "E:\\LmModels\\OS-Software\\Ternary-Bonsai-2-27B-Uncensored-Heretic\\Ternary-Bonsai-2-27B-Uncensored-Heretic-PTQ1_0.gguf"',
      '--host 127.0.0.1',
      '--port 8081',
      '-ngl 99',
      '-np 1',
      '-fa on',
      '-c 32768',
      '-ctk q8_0',
      '-ctv q8_0',
      '-b 512',
      '-ub 256',
      '--temp 1.0',
      '--top-p 0.95',
      '--top-k 20',
      '--min-p 0.05',
      '--jinja',
    ].join(' ')
    const { config, applied, unknown } = applyLaunchCommand(defaultConfig, text)
    expect(config.model_path).toBe('E:\\LmModels\\OS-Software\\Ternary-Bonsai-2-27B-Uncensored-Heretic\\Ternary-Bonsai-2-27B-Uncensored-Heretic-PTQ1_0.gguf')
    expect(config.server.port).toBe(8081)
    expect(config.server.host).toBe('127.0.0.1')
    expect(config.server.mode).toBe('local')
    expect(config.basic.ngl).toBe(99)
    expect(config.basic.ngl_enabled).toBe(true)
    expect(config.basic.parallel).toBe(1)
    expect(config.basic.flash_attn).toBe(true)
    expect(config.basic.ctx_size).toBe(32768)
    expect(config.basic.kv_cache_quant_k).toBe('q8_0')
    expect(config.basic.kv_cache_quant_v).toBe('q8_0')
    expect(config.basic.batch_size).toBe(512)
    expect(config.basic.ubatch_size).toBe(256)
    expect(config.sampling.temperature).toBe(1)
    expect(config.sampling.top_p).toBe(0.95)
    expect(config.sampling.top_k).toBe(20)
    expect(config.sampling.min_p).toBe(0.05)
    expect(config.sampling.min_p_enabled).toBe(true)
    expect(unknown).toEqual(['--jinja'])
    expect(config.extra_params).toContain('--jinja')
    expect(applied).toBeGreaterThan(10)
  })

  it('supports = syntax, bare boolean flags and negative numbers', () => {
    const { config } = applyLaunchCommand(defaultConfig, 'llama-server --ctx-size=8192 --temp=0.7 -fa --no-mmap --cache-ram -1 --fit on --fit-target 2048')
    expect(config.basic.ctx_size).toBe(8192)
    expect(config.sampling.temperature).toBe(0.7)
    expect(config.basic.flash_attn).toBe(true)
    expect(config.basic.mmap).toBe(false)
    expect(config.basic.cache_ram).toBe(-1)
    expect(config.basic.fit_enabled).toBe(true)
    expect(config.basic.fit_target).toBe(2048)
  })

  it('disables fit when -ngl is present after fit flags', () => {
    const { config } = applyLaunchCommand(defaultConfig, 'llama-server --fit on --fit-target 2048 -ngl 42')
    expect(config.basic.fit_enabled).toBe(false)
    expect(config.basic.ngl).toBe(42)
  })

  it('collects unknown flags with their values into extra_params', () => {
    const { config, unknown } = applyLaunchCommand(defaultConfig, 'llama-server -m a.gguf --some-future-flag foo --jinja')
    expect(unknown).toEqual(['--some-future-flag foo', '--jinja'])
    expect(config.extra_params).toBe('--some-future-flag foo --jinja')
  })

  it('handles system prompt, mtp and non-numeric warnings', () => {
    const { config, warnings } = applyLaunchCommand(defaultConfig, 'llama-server --system-prompt "你是助手" --spec-type draft-mtp --spec-draft-n-max 3 -c notanumber')
    expect(config.system_prompt).toBe('你是助手')
    expect(config.mtp.enabled).toBe(true)
    expect(config.mtp.spec_type).toBe('draft-mtp')
    expect(config.mtp.draft_n_max).toBe(3)
    expect(warnings.some(item => item.includes('c 的值 "notanumber"'))).toBe(true)
    expect(config.basic.ctx_size).toBe(defaultConfig.basic.ctx_size)
  })

  it('keeps lan mode for 0.0.0.0', () => {
    const { config } = applyLaunchCommand(defaultConfig, 'llama-server --host 0.0.0.0 --port 9090')
    expect(config.server.mode).toBe('lan')
    expect(config.server.port).toBe(9090)
  })

  it('detects a kvmem command and fills the kvmem fields', () => {
    const text = [
      'llama-kvmem-server.exe',
      '-m "E:\\models\\bonsai.gguf"',
      '-ngl 99',
      '--host 127.0.0.1',
      '--port 18203',
      '-c 131072',
      '-b 128',
      '--ubatch-size 128',
      '-n 10240',
      '--kvmem-budget 24576',
      '--kvmem-gen-reserve 10240',
      '--kvmem-block-tokens 128',
      '--kv-dtype q8_0',
      '--kvmem-query-policy user',
      '--kvmem-query-replay auto',
      '--flash-attn on',
      '--spec-type none',
    ].join(' ')
    const { config, unknown, applied } = applyLaunchCommand(defaultConfig, text)
    expect(config.engine).toBe('kvmem')
    expect(config.kvmem.workspace).toBe(131072)
    expect(config.kvmem.batch).toBe(128)
    expect(config.kvmem.gen_reserve).toBe(10240)
    expect(config.kvmem.budget).toBe(24576)
    expect(config.kvmem.block_tokens).toBe(128)
    expect(config.kvmem.kv_dtype).toBe('q8_0')
    expect(config.kvmem.query_policy).toBe('user')
    expect(config.basic.flash_attn).toBe(true)
    expect(config.mtp.enabled).toBe(false)
    expect(config.server.port).toBe(18203)
    expect(unknown).toEqual([])
    expect(applied).toBeGreaterThan(10)
  })

  it('imports kvmem mtp flags and keeps llama.cpp -n in extra_params', () => {
    const kvm = applyLaunchCommand(defaultConfig, 'llama-kvmem-server --spec-type draft-mtp --spec-draft-n-max 1 --spec-kv-dtype f16 --kvmem-mtp-state snapshots --enable-thinking --reasoning-budget 4096')
    expect(kvm.config.engine).toBe('kvmem')
    expect(kvm.config.mtp.enabled).toBe(true)
    expect(kvm.config.mtp.draft_n_max).toBe(1)
    expect(kvm.config.kvmem.enable_thinking).toBe(true)
    expect(kvm.config.kvmem.reasoning_budget).toBe(4096)
    expect(kvm.unknown).toEqual([])

    const llamacpp = applyLaunchCommand(defaultConfig, 'llama-server -m a.gguf -n 512')
    expect(llamacpp.config.engine).toBe('llama.cpp')
    expect(llamacpp.unknown).toEqual(['-n 512'])
    expect(llamacpp.config.extra_params).toContain('-n 512')
  })

  it('detects the v0.18 unified worker and fills retrieval plus ninfer flags', () => {
    const text = [
      '"D:\\funproject\\llama-manager\\engine\\kvmem-v0.18.0-ninfer-windows-rtx40-sm89\\workers\\ninfer\\ninfer-kvmem-server.exe"',
      '"E:\\models\\bonsai2_27b_ternary_ptq1_native_mtp.ninfer"',
      '--host 127.0.0.1 --port 8095 --model-id qwen3.8-27b',
      '--max-context 204800 --kvmem-budget 36864 --kvmem-gen-reserve 16384 --kvmem-host-mib 12288',
      '--kvmem-sink-tokens 12288 --kvmem-recent-tokens 1024 --kvmem-sessions 1',
      '--kvmem-lrfu --kvmem-lrfu-lambda 0.5 --kvmem-lrfu-top-frac 0.9 --kvmem-score-agg max',
      '--kv-dtype int8 --prefill-chunk 256 --spec mtp --draft-tokens 4 --adaptive-mtp',
      '--ngram-draft-tokens 31 --ngram-min-match 12',
      '--default-max-tokens 16384 --default-reasoning-effort medium --default-thinking-budget 8192 --max-concurrency 1',
      '--max-shared-prefixes 0',
      '--temperature 0.7 --top-p 0.9 --top-k 20',
      '--no-cuda-graph --cors',
    ].join(' ')
    const { config, applied, unknown } = applyLaunchCommand(defaultConfig, text)
    expect(config.engine).toBe('ninfer')
    expect(config.model_path).toBe('E:\\models\\bonsai2_27b_ternary_ptq1_native_mtp.ninfer')
    expect(config.ninfer.max_context).toBe(204800)
    expect(config.ninfer.budget).toBe(36864)
    expect(config.ninfer.gen_reserve).toBe(16384)
    expect(config.ninfer.host_kv_mib).toBe(12288)
    expect(config.ninfer.sink_tokens).toBe(12288)
    expect(config.ninfer.recent_tokens).toBe(1024)
    expect(config.ninfer.sessions).toBe(1)
    expect(config.ninfer.lrfu).toBe(true)
    expect(config.ninfer.lrfu_lambda).toBe(0.5)
    expect(config.ninfer.lrfu_top_frac).toBe(0.9)
    expect(config.ninfer.score_agg).toBe('max')
    expect(config.ninfer.kv_dtype).toBe('int8')
    expect(config.ninfer.adaptive_mtp).toBe(true)
    expect(config.ninfer.ngram_draft_tokens).toBe(31)
    expect(config.ninfer.ngram_min_match).toBe(12)
    expect(config.ninfer.default_thinking_budget).toBe(8192)
    expect(config.ninfer.default_max_tokens).toBe(16384)
    expect(config.ninfer.cuda_graph).toBe(false)
    expect(config.ninfer.model_id).toBe('qwen3.8-27b')
    expect(config.basic.enable_thinking).toBe(true)
    expect(config.ninfer.reasoning_effort).toBe('medium')
    expect(config.server.port).toBe(8095)
    // Unmapped-but-valid ninfer flags stay in extra_params so the built
    // command keeps them verbatim.
    expect(unknown).toEqual(['--max-shared-prefixes 0', '--cors'])
    expect(applied).toBeGreaterThan(20)
  })

  it('parses a ninfer launcher bat, dropping boilerplate and joining continuations', () => {
    const bat = [
      '@echo off',
      'set "ROOT=E:\\pack"',
      'rem generated launcher',
      '"E:\\pack\\workers\\ninfer\\ninfer-kvmem-server.exe" "E:\\pack\\models\\m.ninfer" ^',
      '  --host 127.0.0.1 --port 8095 ^',
      '  --max-context 204800 --kvmem-budget 16384 --kvmem-gen-reserve 8192 ^',
      '  --kvmem-sink-tokens 8192 --kvmem-recent-tokens 1024 --kvmem-lrfu ^',
      '  --spec mtp --draft-tokens 4 --no-cuda-graph --default-reasoning-effort none',
    ].join('\r\n')
    const { config, applied, unknown } = applyLaunchCommand(defaultConfig, bat)
    expect(config.engine).toBe('ninfer')
    expect(config.model_path).toBe('E:\\pack\\models\\m.ninfer')
    expect(config.ninfer.budget).toBe(16384)
    expect(config.ninfer.gen_reserve).toBe(8192)
    expect(config.ninfer.sink_tokens).toBe(8192)
    expect(config.ninfer.lrfu).toBe(true)
    expect(config.ninfer.spec).toBe('mtp')
    expect(config.ninfer.cuda_graph).toBe(false)
    expect(unknown).toEqual([])
    expect(applied).toBeGreaterThan(10)
  })

  it('keeps --kvmem flags on the ninfer engine when no binary name is given', () => {
    const { config } = applyLaunchCommand(defaultConfig, 'ninfer-kvmem-server m.ninfer --kvmem-budget 8192 --max-context 32768')
    expect(config.engine).toBe('ninfer')
    expect(config.ninfer.budget).toBe(8192)
  })

  it('maps kvmem GGUF retrieval flags onto the kvmem block', () => {
    const { config } = applyLaunchCommand(defaultConfig, 'llama-kvmem-server -m m.gguf --kvmem-budget 24576 --kvmem-sink-tokens 12288 --kvmem-recent-tokens 1024 --kvmem-lrfu --kvmem-lrfu-lambda 0.7 --kvmem-score-agg max')
    expect(config.engine).toBe('kvmem')
    expect(config.kvmem.budget).toBe(24576)
    expect(config.kvmem.sink_tokens).toBe(12288)
    expect(config.kvmem.recent_tokens).toBe(1024)
    expect(config.kvmem.lrfu).toBe(true)
    expect(config.kvmem.lrfu_lambda).toBe(0.7)
    expect(config.kvmem.score_agg).toBe('max')
  })


  it('maps dflash draft windows and spec none for ninfer', () => {
    const { config } = applyLaunchCommand(defaultConfig, 'ninfer-serve-89.exe m.ninfer --spec dflash2 --draft-tokens 12 --adaptive-mtp')
    expect(config.engine).toBe('ninfer')
    expect(config.ninfer.spec).toBe('dflash2')
    expect(config.ninfer.draft_tokens).toBe(12)
    expect(config.ninfer.adaptive_mtp).toBe(true)

    const off = applyLaunchCommand(defaultConfig, 'ninfer-serve-89.exe m.ninfer --spec none')
    expect(off.config.ninfer.spec).toBe('none')
  })

  it('routes kv-dtype to the ninfer block for ninfer commands and to kvmem otherwise', () => {
    const ninfer = applyLaunchCommand(defaultConfig, 'ninfer-serve-89.exe m.ninfer --kv-dtype rk8v4')
    expect(ninfer.config.ninfer.kv_dtype).toBe('rk8v4')
    expect(ninfer.config.kvmem.kv_dtype).toBe('q8_0')
    const kvm = applyLaunchCommand(defaultConfig, 'llama-kvmem-server -m m.gguf --kv-dtype q4_0')
    expect(kvm.config.kvmem.kv_dtype).toBe('q4_0')
  })
})
