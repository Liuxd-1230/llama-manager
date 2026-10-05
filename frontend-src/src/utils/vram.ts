import type { AppConfig } from '../types'

// VRAM estimate for the 8 GB laptop card, using coefficients measured on the
// Bonsai-2 27B family (see docs/profile-guide.md). Other models will drift —
// the numbers are labeled as estimates wherever they surface.
const DESKTOP_GB = 1
const BUFFERS_GB = 0.4
const SAFE_BUDGET_GB = 7.4

// KV cost per 1,000 tokens: ~25 KB at q8-grade, ~12.5 KB at q4-grade.
function kvKbPerToken(dtype: string) { return /q4|k4|nvfp4|rk2/i.test(dtype) ? 12.5 : 25 }

export interface VramPart { label: string; gb: number }
export interface VramInput {
  engine: string
  modelSizeMb: number
  ctxSize: number
  kvCacheQuant: string
  flashAttn: boolean
  kvmem: { budget: number; gen_reserve: number; kv_dtype: string }
  ninfer: { kv_capacity: number; prefill_chunk: number; cuda_graph: boolean }
}

export interface VramEstimate { parts: VramPart[]; totalGb: number; over: boolean }

export function estimateVram(input: VramInput): VramEstimate {
  const parts: VramPart[] = [{ label: '桌面', gb: DESKTOP_GB }]
  const weights = input.modelSizeMb / 1024
  if (weights > 0) parts.push({ label: '权重', gb: weights })
  if (input.engine === 'kvmem') {
    const kb = kvKbPerToken(input.kvmem.kv_dtype)
    parts.push({ label: 'KV(预算+预留)', gb: ((input.kvmem.budget + input.kvmem.gen_reserve) * kb) / 1024 / 1024 })
    parts.push({ label: '缓冲', gb: BUFFERS_GB })
  } else if (input.engine === 'ninfer') {
    if (input.ninfer.kv_capacity > 0) parts.push({ label: 'KV 池', gb: (input.ninfer.kv_capacity * 27.3) / 1024 / 1024 })
    parts.push({ label: '工作区', gb: input.ninfer.prefill_chunk > 0 ? Math.max(0.15, 0.436 * (input.ninfer.prefill_chunk / 256)) : 0.44 })
    if (input.ninfer.cuda_graph) parts.push({ label: 'CUDA Graphs', gb: 0.853 })
  } else {
    const kb = kvKbPerToken(input.kvCacheQuant)
    parts.push({ label: `KV(全量 ${Math.round(input.ctxSize / 1024)}K)`, gb: (input.ctxSize * kb) / 1024 / 1024 })
    parts.push({ label: '缓冲', gb: BUFFERS_GB })
  }
  const totalGb = Math.round(parts.reduce((sum, part) => sum + part.gb, 0) * 100) / 100
  return { parts, totalGb, over: totalGb > SAFE_BUDGET_GB }
}

export function estimateFromConfig(config: AppConfig, modelSizeMb = 0): VramEstimate {
  return estimateVram({
    engine: config.engine,
    modelSizeMb,
    ctxSize: config.basic.ctx_size,
    kvCacheQuant: config.basic.kv_cache_quant_k || config.basic.kv_cache_quant_v || 'q8_0',
    flashAttn: config.basic.flash_attn,
    kvmem: { budget: config.kvmem.budget, gen_reserve: config.kvmem.gen_reserve, kv_dtype: config.kvmem.kv_dtype },
    ninfer: { kv_capacity: config.ninfer.kv_capacity, prefill_chunk: config.ninfer.prefill_chunk, cuda_graph: config.ninfer.cuda_graph },
  })
}
