import type { AppConfig } from '../types'

// VRAM/RAM estimator. KV cost comes from each model's own geometry when the
// backend could read it (GGUF header math / .ninfer manifest), falling back to
// coefficients measured on the Bonsai-2 27B family (docs/profile-guide.md).
const DESKTOP_GB = 1
const BUFFERS_GB = 0.4
const SAFE_BUDGET_GB = 7.4

// Bytes per KV element relative to f16 (2 bytes), by cache dtype.
function dtypeFactor(dtype: string) {
  if (/q4|k4|nvfp4|rk2/i.test(dtype)) return 0.29
  if (/q8|int8|k8/i.test(dtype)) return 0.55
  return 1
}

// Measured constant for .ninfer artifacts (k8v4 on bonsai2-27b): 27.3 KB/token.
const NINFER_KV_BYTES_PER_TOKEN = 27300

export interface ModelGeom {
  // Final per-token KV bytes (dtype already applied) — .ninfer manifest.
  kv_bytes_per_token?: number
  // f16 baseline from the GGUF header — apply the dtype factor per engine.
  kv_bytes_per_token_f16?: number
  hidden?: number
  kv_layers?: number
}

export interface VramPart { label: string; gb: number }
export interface UsageEstimate {
  vram: { parts: VramPart[]; totalGb: number; over: boolean }
  ram: { parts: VramPart[]; totalGb: number }
}

export interface VramInput {
  engine: string
  modelSizeMb: number
  ctxSize: number
  kvCacheQuant: string
  kvmem: { budget: number; gen_reserve: number; kv_dtype: string; host_kv_mib?: number }
  ninfer: { kv_capacity: number; prefill_chunk: number; cuda_graph: boolean; host_kv_mib: number }
  geom?: ModelGeom
}

// bytesPerToken is in BYTES (geometry math / ninfer constant): bytes × tokens
// → GB requires /1024³.
const kb = (bytesPerToken: number, tokens: number, factor = 1) =>
  (bytesPerToken * tokens * factor) / 1024 / 1024 / 1024

// Per-token KV bytes: model geometry when the backend could read it, else
// the Bonsai-measured fallback (25 KB q8-grade / 27.3 KB ninfer k8v4).
function resolveKvBytes(input: VramInput) {
  const geom = input.geom
  if (geom?.kv_bytes_per_token) return geom.kv_bytes_per_token
  if (geom?.kv_bytes_per_token_f16) {
    const factor = input.engine === 'ninfer' ? 1 : dtypeFactor(input.engine === 'kvmem' ? input.kvmem.kv_dtype : input.kvCacheQuant)
    return geom.kv_bytes_per_token_f16 * factor
  }
  return input.engine === 'ninfer' ? NINFER_KV_BYTES_PER_TOKEN : 25000
}

export function estimateUsage(input: VramInput): UsageEstimate {
  const parts: VramPart[] = [{ label: '桌面', gb: DESKTOP_GB }]
  const weights = input.modelSizeMb / 1024
  if (weights > 0) parts.push({ label: '权重', gb: weights })

  const kvBytes = resolveKvBytes(input)
  const kvTokens = (label: string, tokens: number, factor = 1) =>
    parts.push({ label, gb: Math.round(kb(kvBytes, tokens, factor) * 100) / 100 })

  let ramParts: VramPart[] = []
  if (weights > 0) ramParts = [{ label: '权重(mmap/常驻)', gb: weights }]

  if (input.engine === 'kvmem') {
    kvTokens('KV(预算+预留)', input.kvmem.budget + input.kvmem.gen_reserve)
    parts.push({ label: '缓冲', gb: BUFFERS_GB })
    ramParts.push({ label: '运行时', gb: 0.6 })
  } else if (input.engine === 'ninfer') {
    if (input.ninfer.kv_capacity > 0) kvTokens('KV 池', input.ninfer.kv_capacity)
    parts.push({ label: '工作区', gb: input.ninfer.prefill_chunk > 0 ? Math.max(0.15, 0.436 * (input.ninfer.prefill_chunk / 256)) : 0.44 })
    if (input.ninfer.cuda_graph) parts.push({ label: 'CUDA Graphs', gb: 0.853 })
    ramParts.push({ label: '主机 KV 池(钉住)', gb: input.ninfer.host_kv_mib / 1024 })
    ramParts.push({ label: '运行时+状态', gb: 1.2 })
  } else {
    kvTokens(`KV(全量 ${Math.round(input.ctxSize / 1024)}K)`, input.ctxSize)
    parts.push({ label: '缓冲', gb: BUFFERS_GB })
    ramParts.push({ label: '运行时', gb: 0.6 })
  }

  const vramTotal = Math.round(parts.reduce((sum, part) => sum + part.gb, 0) * 100) / 100
  const ramTotal = Math.round(ramParts.reduce((sum, part) => sum + part.gb, 0) * 100) / 100
  return {
    vram: { parts, totalGb: vramTotal, over: vramTotal > SAFE_BUDGET_GB },
    ram: { parts: ramParts, totalGb: ramTotal },
  }
}

export function estimateFromConfig(config: AppConfig, modelSizeMb = 0, geom?: ModelGeom): UsageEstimate {
  return estimateUsage({
    engine: config.engine,
    modelSizeMb,
    ctxSize: config.basic.ctx_size,
    kvCacheQuant: config.basic.kv_cache_quant_k || config.basic.kv_cache_quant_v || 'q8_0',
    kvmem: { budget: config.kvmem.budget, gen_reserve: config.kvmem.gen_reserve, kv_dtype: config.kvmem.kv_dtype },
    ninfer: { kv_capacity: config.ninfer.kv_capacity, prefill_chunk: config.ninfer.prefill_chunk, cuda_graph: config.ninfer.cuda_graph, host_kv_mib: config.ninfer.host_kv_mib },
    geom,
  })
}
