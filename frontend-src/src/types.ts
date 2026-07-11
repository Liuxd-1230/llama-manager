export type Theme = 'light' | 'dark'
export type PageId = 'config' | 'run' | 'optimize' | 'maintenance' | 'chat'

export interface AppConfig {
  llama_cpp_dir: string
  model_path: string
  mmproj_path: string
  basic: {
    ctx_size: number
    ngl_enabled: boolean
    ngl: number
    threads: number
    parallel: number
    mmap: boolean
    mlock: boolean
    n_cpu_moe: number
    kv_cache_quant_k: string
    kv_cache_quant_v: string
    enable_thinking: boolean
    kv_offload: boolean
    flash_attn: boolean
    fit_enabled: boolean
    fit_target: number
    kv_unified: boolean
    batch_size: number
    ubatch_size: number
    context_shift: boolean
    cache_ram: number
  }
  sampling: {
    temperature: number
    top_k: number
    top_p: number
    min_p_enabled: boolean
    min_p: number
    repeat_penalty_enabled: boolean
    repeat_penalty: number
    presence_penalty_enabled: boolean
    presence_penalty: number
  }
  mtp: {
    enabled: boolean
    spec_type: string
    draft_n_max: number
    draft_n_min: number
    p_min: number
    p_split: number
  }
  system_prompt: string
  extra_params: string
  server: { host: string; port: number; mode: string }
  compile: { command: string }
}

export interface Provider {
  id: string
  name: string
  kind: 'local' | 'deepseek' | 'openai_chat' | 'openai_responses' | 'anthropic' | 'openai_compatible'
  base_url?: string
  default_model?: string
  models?: string[]
  enabled?: boolean
  api_key_env?: string
  api_key_set?: boolean
  api_key_source?: string
  migration_error?: string
}

export interface SearchSettings {
  provider: 'tavily' | 'brave'
  providers: Array<{ id: 'tavily' | 'brave'; name: string; env_var: string; configured: boolean; source: string }>
}

export interface ToolEvent {
  id?: string
  type: 'status' | 'call' | 'result' | 'retry' | 'limit' | 'tool_status' | 'tool_call' | 'tool_result'
  name?: string
  query?: string
  limit?: number | string
  message?: string
  summary?: string
}

export interface Candidate {
  id: string
  backendId?: string
  provider: string
  model: string
  content: string
  reasoning: string
  tools: ToolEvent[]
  status: 'streaming' | 'done' | 'stopped' | 'error'
  error?: string
}

export interface ChatTurn {
  id: string
  user: { content: string; display: string }
  candidates: Candidate[]
  activeCandidateId: string
}

export const defaultConfig: AppConfig = {
  llama_cpp_dir: '', model_path: '', mmproj_path: '',
  basic: {
    ctx_size: 4096, ngl_enabled: true, ngl: 99, threads: 8, parallel: 1,
    mmap: true, mlock: false, n_cpu_moe: 0, kv_cache_quant_k: '', kv_cache_quant_v: '',
    enable_thinking: false, kv_offload: true, flash_attn: false, fit_enabled: false,
    fit_target: 256, kv_unified: true, batch_size: 2048, ubatch_size: 512,
    context_shift: false, cache_ram: -1,
  },
  sampling: {
    temperature: .7, top_k: 40, top_p: .95, min_p_enabled: false, min_p: .05,
    repeat_penalty_enabled: false, repeat_penalty: 1.1, presence_penalty_enabled: false,
    presence_penalty: 0,
  },
  mtp: { enabled: false, spec_type: 'draft-mtp', draft_n_max: 3, draft_n_min: 0, p_min: 0, p_split: .1 },
  system_prompt: '', extra_params: '',
  server: { host: '127.0.0.1', port: 8080, mode: 'local' },
  compile: { command: 'cmake -B build -DGGML_CUDA=ON && cmake --build build --config Release -j12' },
}
