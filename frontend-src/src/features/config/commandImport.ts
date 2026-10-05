import type { AppConfig } from '../../types'

export type CommandImportResult = {
  config: AppConfig
  applied: number
  unknown: string[]
  warnings: string[]
}

// Splits on whitespace while keeping "quoted spans" (Windows paths) as one token.
export function tokenizeCommand(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3])
  }
  return tokens
}

// Parses a llama-server / llama-kvmem-server / ninfer-serve command line back
// into config fields. The engine is auto-detected from the binary token or
// --kvmem-/--spec flags. Flags we don't know are preserved verbatim into
// extra_params so nothing is lost — they are appended last by build_command,
// exactly where the user typed them anyway.
export function applyLaunchCommand(base: AppConfig, text: string): CommandImportResult {
  const config: AppConfig = JSON.parse(JSON.stringify(base))
  let applied = 0
  const unknown: string[] = []
  const warnings: string[] = []

  // .bat launchers: pull NINFER_* env assignments out of `set "VAR=value"`
  // lines, then strip bat boilerplate (^ continuations, REM/@echo/set/pause).
  let batEnv: Record<string, string> = {}
  let clean = text
  if (/NINFER_[A-Z0-9_]+\s*=/.test(text)) {
    batEnv = Object.fromEntries(
      [...text.matchAll(/NINFER_([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?"?/g)].map(match => [match[1], match[2].trim()])
    )
    clean = text
      .split(/\r?\n/)
      .filter(line => !/^\s*(@|rem\b|::|set|if\b|not\b|pause|echo)/i.test(line.trim()))
      .join(' ')
  }
  clean = clean.replace(/\^\s*\r?\n?/g, ' ')
  const tokens = tokenizeCommand(clean)

  const binaryToken = (tokens[0] || '').toLowerCase()
  let engine: AppConfig['engine'] | undefined
  if (binaryToken.includes('kvmem-server')) engine = 'kvmem'
  else if (binaryToken.includes('ninfer-serve')) engine = 'ninfer'
  else if (binaryToken.includes('llama-server')) engine = 'llama.cpp'
  if (!engine && tokens.some(token => token.startsWith('--kvmem-'))) engine = 'kvmem'
  if (!engine && tokens.some(token => ['--spec', '--kv-capacity', '--host-kv-mib', '--max-context', '--no-cuda-graph'].includes(token.toLowerCase()))) engine = 'ninfer'
  if (engine) config.engine = engine
  const isKvmem = config.engine === 'kvmem'
  const isNinfer = config.engine === 'ninfer'

  // NInfer takes the model as a bare positional argument (no -m flag).
  if (isNinfer) {
    const positional = tokens.slice(1).find(token => !token.startsWith('-'))
    if (positional) { config.model_path = positional; applied += 1 }
    const window = Number(batEnv.KV_WINDOW)
    if (batEnv.KV_WINDOW && Number.isFinite(window) && window > 0) { config.ninfer.kv_window = window; applied += 1 }
    const retrieve = Number(batEnv.KV_RETRIEVE)
    if (batEnv.KV_RETRIEVE && Number.isFinite(retrieve) && retrieve > 0) { config.ninfer.kv_retrieve = retrieve; applied += 1 }
    if (batEnv.TERNARY_PTQ1_FAST) { config.ninfer.ptq1_fast = batEnv.TERNARY_PTQ1_FAST !== '0'; applied += 1 }
  }

  const integer = (value: string, flag: string): number | null => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      warnings.push(`参数 ${flag} 的值 "${value}" 不是数字，已跳过`)
      return null
    }
    return parsed
  }

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token.startsWith('-')) continue
    let flag = token.replace(/^-{1,2}/, '').toLowerCase()
    let inlineValue: string | undefined
    const eq = flag.indexOf('=')
    if (eq >= 0) {
      inlineValue = flag.slice(eq + 1)
      flag = flag.slice(0, eq)
    }
    // Returns the flag's value: from --flag=value, or the next token when it
    // does not look like another flag (negative numbers like -1 still count).
    const take = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue
      const next = tokens[index + 1]
      if (next === undefined) return undefined
      if (next.startsWith('-') && !/^-\d/.test(next)) return undefined
      index += 1
      return next
    }
    const use = (fn: (value: string) => void) => {
      const value = take()
      if (value !== undefined) {
        fn(value)
        applied += 1
      }
    }
    const optionalOnOff = (set: (on: boolean) => void) => {
      const value = take()
      set(value !== 'off')
      applied += 1
    }

    switch (flag) {
      case 'm': case 'model': use(value => { config.model_path = value }); break
      case 'mmproj': use(value => { config.mmproj_path = value }); break
      case 'mmproj-offload': config.mmproj_gpu = true; applied += 1; break
      case 'no-mmproj-offload': config.mmproj_gpu = false; applied += 1; break
      case 'c': case 'ctx-size': use(value => {
        const n = integer(value, flag)
        if (n === null) return
        if (isKvmem) config.kvmem.workspace = n
        else config.basic.ctx_size = n
      }); break
      case 'ngl': case 'n-gpu-layers': use(value => { const n = integer(value, flag); if (n !== null) { config.basic.ngl = n; config.basic.ngl_enabled = true; config.basic.fit_enabled = false } }); break
      case 'fit-target': use(value => { const n = integer(value, flag); if (n !== null) { config.basic.fit_enabled = true; config.basic.fit_target = n } }); break
      case 't': case 'threads': use(value => { const n = integer(value, flag); if (n !== null) config.basic.threads = n }); break
      case 'np': case 'parallel': use(value => { const n = integer(value, flag); if (n !== null) config.basic.parallel = n }); break
      case 'n-cpu-moe': use(value => { const n = integer(value, flag); if (n !== null) config.basic.n_cpu_moe = n }); break
      case 'ctk': case 'cache-type-k': use(value => { config.basic.kv_cache_quant_k = value }); break
      case 'ctv': case 'cache-type-v': use(value => { config.basic.kv_cache_quant_v = value }); break
      case 'b': case 'batch-size': use(value => { const n = integer(value, flag); if (n !== null) { if (isKvmem) config.kvmem.batch = n; else config.basic.batch_size = n } }); break
      case 'ub': case 'ubatch-size': use(value => { const n = integer(value, flag); if (n !== null) { if (isKvmem) config.kvmem.ubatch = n; else config.basic.ubatch_size = n } }); break
      case 'cache-ram': case 'cram': use(value => { const n = integer(value, flag); if (n !== null) config.basic.cache_ram = n }); break
      case 'kvmem-budget': use(value => { const n = integer(value, flag); if (n !== null) config.kvmem.budget = n }); break
      case 'kvmem-gen-reserve': use(value => { const n = integer(value, flag); if (n !== null) config.kvmem.gen_reserve = n }); break
      case 'kvmem-block-tokens': use(value => { const n = integer(value, flag); if (n !== null) config.kvmem.block_tokens = n }); break
      case 'n': {
        if (!isKvmem) {
          // llama.cpp's -n (predict) has no config field — keep it verbatim.
          const raw = take()
          unknown.push(raw !== undefined ? `${token} ${raw}` : token)
          break
        }
        use(value => { const n = integer(value, flag); if (n !== null) config.kvmem.gen_reserve = n })
        break
      }
      case 'kv-dtype': use(value => { if (isNinfer) config.ninfer.kv_dtype = value; else config.kvmem.kv_dtype = value }); break
      case 'kvmem-query-policy': use(value => { config.kvmem.query_policy = value }); break
      case 'kvmem-mtp-state': use(value => { config.kvmem.mtp_state = value }); break
      case 'kvmem-query-replay': case 'spec-kv-dtype': use(() => {}); break
      case 'reasoning-budget': use(value => { const n = integer(value, flag); if (n !== null && isKvmem) { config.kvmem.enable_thinking = true; config.kvmem.reasoning_budget = n } }); break
      case 'temp': case 'temperature': use(value => { const n = Number(value); if (Number.isFinite(n)) config.sampling.temperature = n }); break
      case 'top-k': use(value => { const n = integer(value, flag); if (n !== null) config.sampling.top_k = n }); break
      case 'top-p': use(value => { const n = Number(value); if (Number.isFinite(n)) config.sampling.top_p = n }); break
      case 'min-p': use(value => { const n = Number(value); if (Number.isFinite(n)) { config.sampling.min_p = n; config.sampling.min_p_enabled = true } }); break
      case 'repeat-penalty': use(value => { const n = Number(value); if (Number.isFinite(n)) { config.sampling.repeat_penalty = n; config.sampling.repeat_penalty_enabled = true } }); break
      case 'presence-penalty': use(value => { const n = Number(value); if (Number.isFinite(n)) { config.sampling.presence_penalty = n; config.sampling.presence_penalty_enabled = true } }); break
      case 'host': use(value => { config.server.host = value; config.server.mode = value === '0.0.0.0' ? 'lan' : 'local' }); break
      case 'port': use(value => { const n = integer(value, flag); if (n !== null) config.server.port = n }); break
      case 'system-prompt': use(value => { config.system_prompt = value }); break
      case 'chat-template-file': use(value => { config.chat_template_file = value }); break
      case 'spec-type': use(value => {
        if (value.includes('draft')) { config.mtp.enabled = true; config.mtp.spec_type = value }
        else if (value === 'none') { config.mtp.enabled = false }
      }); break
      case 'spec-draft-n-max': use(value => { const n = integer(value, flag); if (n !== null) { config.mtp.enabled = true; config.mtp.draft_n_max = n } }); break
      case 'spec-draft-n-min': use(value => { const n = integer(value, flag); if (n !== null) { config.mtp.enabled = true; config.mtp.draft_n_min = n } }); break
      case 'spec-draft-p-min': use(value => { const n = Number(value); if (Number.isFinite(n)) { config.mtp.enabled = true; config.mtp.p_min = n } }); break
      case 'spec-draft-p-split': use(value => { const n = Number(value); if (Number.isFinite(n)) { config.mtp.enabled = true; config.mtp.p_split = n } }); break
      case 'fa': case 'flash-attn': optionalOnOff(on => { config.basic.flash_attn = on }); break
      case 'fit': optionalOnOff(on => { config.basic.fit_enabled = on }); break
      case 'mmap': config.basic.mmap = true; applied += 1; break
      case 'no-mmap': config.basic.mmap = false; applied += 1; break
      case 'mlock': config.basic.mlock = true; applied += 1; break
      case 'no-kv-offload': config.basic.kv_offload = false; applied += 1; break
      case 'kv-unified': config.basic.kv_unified = true; applied += 1; break
      case 'no-kv-unified': config.basic.kv_unified = false; applied += 1; break
      case 'context-shift': config.basic.context_shift = true; applied += 1; break
      case 'reasoning': optionalOnOff(on => { config.basic.enable_thinking = on }); break
      case 'enable-thinking': config.basic.enable_thinking = true; if (isKvmem) config.kvmem.enable_thinking = true; applied += 1; break
      // NInfer flags
      case 'max-context': use(value => { const n = integer(value, flag); if (n !== null) config.ninfer.max_context = n }); break
      case 'kv-capacity': use(value => { const n = integer(value, flag); if (n !== null) config.ninfer.kv_capacity = Math.max(0, n) }); break
      case 'host-kv-mib': use(value => { const n = integer(value, flag); if (n !== null) config.ninfer.host_kv_mib = Math.max(0, n) }); break
      case 'prefill-chunk': use(value => { const n = integer(value, flag); if (n !== null) config.ninfer.prefill_chunk = Math.max(0, n) }); break
      case 'max-concurrency': use(value => { const n = integer(value, flag); if (n !== null) config.ninfer.max_concurrency = Math.min(8, Math.max(1, n)) }); break
      case 'default-max-tokens': use(value => { const n = integer(value, flag); if (n !== null) config.ninfer.default_max_tokens = Math.max(0, n) }); break
      case 'no-cuda-graph': config.ninfer.cuda_graph = false; applied += 1; break
      case 'spec': use(value => { config.ninfer.spec = ['mtp', 'dflash', 'dflash2'].includes(value) ? value : 'none' }); break
      case 'draft-tokens': use(value => { const n = integer(value, flag); if (n !== null) config.ninfer.draft_tokens = Math.min(15, Math.max(1, n)) }); break
      case 'adaptive-mtp': config.ninfer.adaptive_mtp = true; applied += 1; break
      case 'model-id': use(value => { config.ninfer.model_id = value }); break
      case 'default-reasoning-effort': use(value => {
        if (value === 'none') config.basic.enable_thinking = false
        else { config.basic.enable_thinking = true; config.ninfer.reasoning_effort = value }
      }); break
      default: {
        if (inlineValue !== undefined) {
          unknown.push(token)
        } else {
          const value = take()
          unknown.push(value !== undefined ? `${token} ${value}` : token)
        }
      }
    }
  }

  if (unknown.length) {
    config.extra_params = [base.extra_params?.trim(), ...unknown].filter(Boolean).join(' ')
  }
  return { config, applied, unknown, warnings }
}
