import type { AppConfig } from '../types'

// VRAM/RAM estimator. KV cost comes from each model's own geometry when the
// backend could read it (GGUF header math / .ninfer manifest), falling back to
// coefficients measured on the Bonsai-2 27B family (docs/profile-guide.md).
const DESKTOP_GB = 1
const SAFE_BUDGET_GB = 7.4

// Bytes per KV element relative to f16 (2 bytes), by cache dtype.
function dtypeFactor(dtype: string) {
  if (/q4|k4|nvfp4|rk2/i.test(dtype)) return 0.47   // calibrated: 15.1 / 32 KB
  if (/q8|int8|k8/i.test(dtype)) return 0.73
  return 1
}

// Measured on this machine (nvidia-smi deltas, 2026-10-06):
//  - llama.cpp KV slope 31.7 KB/token(f16) = geometry formula within 1%
//  - llama.cpp non-KV base 5.08 GB with a 5.76 GB model (compute/KV buffer
//    overlap) → per-model scratch ≈ weights × −0.12 + 1.6 GB, floor 0
//  - KVMem budget slope 15.1 KB/token(q4_0) vs the old 12.5 guess
//  - KVMem non-KV base 5.36 GB incl. desktop
//  - ninfer total 7.68 GB vs estimate 7.27 (+5%)
const LLAMA_SCRATCH_SCALE = -0.12
const LLAMA_SCRATCH_BASE_GB = 1.6
const KVMEM_BASE_GB = 5.36 - DESKTOP_GB  // engine-side, desktop counted separately

// Measured constant for .ninfer artifacts (k8v4 on bonsai2-27b): 27.3 KB/token.
const NINFER_KV_BYTES_PER_TOKEN = 27300

export interface ModelGeom {
  // Final per-token KV bytes (dtype already applied) — .ninfer manifest.
  kv_bytes_per_token?: number
  // f16 baseline from the GGUF header — apply the dtype factor per engine.
  // Dense: Σ(per-layer KV heads) × head_dim × 2 bytes, full context on every
  // layer. Sliding-window models must use the per-layer fields below.
  kv_bytes_per_token_f16?: number
  hidden?: number
  kv_layers?: number
  experts?: number
  moe_layers?: number
  // Sliding-window (gemma family) geometry: per-layer KV head counts plus the
  // window and the full-attention layer count from the GGUF header.
  kv_heads?: number[]
  head_dim?: number
  sliding_window?: number
  full_layers?: number
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
  nCpuMoe?: number
  kvmem: { budget: number; gen_reserve: number; kv_dtype: string; host_kv_mib?: number }
  ninfer: { budget: number; gen_reserve: number; prefill_chunk: number; cuda_graph: boolean; host_kv_mib: number }
  // llama.cpp --fit on: the engine moves weight layers to RAM to leave the
  // fit target free, so weights no longer count fully against VRAM.
  fitEnabled?: boolean

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

// Sliding-window geometry of the model, when the GGUF header exposes the
// gemma-family fields. `full_layers` falls back to the minimal KV-head count:
// in this family the global (full-context) layers carry a single KV head.
// Verified against a measured gemma4-12B launch (7171 MiB total, 2026-10-31).
function slidingGeometry(geom?: ModelGeom): { window: number; fullLayers: number } | null {
  if (!geom?.kv_heads?.length || !geom.head_dim || !geom.sliding_window) return null
  const fullLayers = geom.full_layers ?? geom.kv_heads.filter(h => h === Math.min(...geom.kv_heads!)).length
  return { window: geom.sliding_window, fullLayers }
}

// KV bytes for the whole cache, dtype applied. Window-aware when the sliding
// geometry is known: sliding layers only cache `window` tokens, full-attention
// layers cache the whole context.
function resolveKvCacheBytes(input: VramInput): number {
  const geom = input.geom
  const sliding = slidingGeometry(geom)
  if (geom?.kv_heads?.length && geom.head_dim && sliding) {
    const factor = dtypeFactor(input.kvCacheQuant)
    let bytes = 0
    for (const heads of geom.kv_heads) {
      const isFull = heads === Math.min(...geom.kv_heads!)
      const tokens = isFull ? input.ctxSize : Math.min(input.ctxSize, sliding.window)
      bytes += 2 * heads * geom.head_dim * 2 * tokens
    }
    return bytes * factor
  }
  return resolveKvBytes(input) * input.ctxSize
}

export function estimateUsage(input: VramInput): UsageEstimate {
  const parts: VramPart[] = [{ label: '桌面', gb: DESKTOP_GB }]
  const weights = input.modelSizeMb / 1024

  // MoE expert offload (--n-cpu-moe): calibrated on Hermes3.6-35B-A3B Q4
  // (Prism build): non-expert anchor 1.46 GB, ~0.425 GB per GPU-resident
  // expert layer; expert bytes ≈ 94% of this family's file size. Offloaded
  // layers move to RAM, mirrored on both bars.
  const moeLayers = input.geom?.experts ? input.geom.moe_layers ?? 0 : 0
  const expertPerLayerGb = moeLayers ? (weights * 0.94) / moeLayers : 0
  const offloaded = Math.min(input.nCpuMoe ?? 0, moeLayers)
  const gpuWeights = Math.max(weights - offloaded * expertPerLayerGb, weights * 0.06)
  const offloadedGb = weights - gpuWeights
  if (weights > 0) parts.push({ label: offloadedGb > 0.01 ? `权重(GPU 侧)`: '权重', gb: gpuWeights })

  const kvBytes = resolveKvBytes(input)
  const kvTokens = (label: string, tokens: number, factor = 1) =>
    parts.push({ label, gb: Math.round(kb(kvBytes, tokens, factor) * 100) / 100 })

  let ramParts: VramPart[] = []
  if (weights > 0) ramParts = [{ label: offloadedGb > 0.01 ? `权重(CPU 专家×${offloaded})` : '权重(mmap/常驻)', gb: offloadedGb > 0.01 ? offloadedGb : weights }]

  if (input.engine === 'kvmem') {
    kvTokens('KV(预算+预留)', input.kvmem.budget + input.kvmem.gen_reserve)
    parts.push({ label: '缓冲(实测)', gb: Math.max(0, KVMEM_BASE_GB - gpuWeights) })
    ramParts.push({ label: '运行时', gb: 0.6 })
  } else if (input.engine === 'ninfer') {
    kvTokens('KV(预算+预留)', input.ninfer.budget + input.ninfer.gen_reserve)
    parts.push({ label: '工作区', gb: input.ninfer.prefill_chunk > 0 ? Math.max(0.15, 0.436 * (input.ninfer.prefill_chunk / 256)) : 0.44 })
    if (input.ninfer.cuda_graph) parts.push({ label: 'CUDA Graphs', gb: 0.853 })
    ramParts.push({ label: '主机 KV 预算(钉住)', gb: input.ninfer.host_kv_mib / 1024 })
    ramParts.push({ label: '运行时+状态', gb: 1.2 })
  } else {
    const kvGb = Math.round(resolveKvCacheBytes(input) / 1024 / 1024 / 1024 * 100) / 100
    const sliding = slidingGeometry(input.geom)
    parts.push({ label: sliding ? `KV(SWA 窗口${sliding.window}，${Math.round(input.ctxSize / 1024)}K)` : `KV(全量 ${Math.round(input.ctxSize / 1024)}K)`, gb: kvGb })
    // Calibrated scratch: grows sub-linearly with weights (buffer reuse).
    const scratch = Math.max(0, gpuWeights * LLAMA_SCRATCH_SCALE + LLAMA_SCRATCH_BASE_GB)
    parts.push({ label: '计算/分配缓冲', gb: scratch })
    ramParts.push({ label: '运行时', gb: 0.6 })
    if (input.fitEnabled) {
      // --fit on: llama.cpp keeps as many weight layers on the GPU as leave
      // the fit target free, mirroring the MoE offload split.
      const fixed = DESKTOP_GB + kvGb + scratch
      const weightsGpu = Math.max(Math.min(weights, SAFE_BUDGET_GB - fixed), 0)
      const offloadFit = Math.max(weights - weightsGpu, 0)
      if (offloadFit > 0.01) {
        const vramPart = parts.find(part => part.label.startsWith('权重'))
        if (vramPart) vramPart.gb = weightsGpu
        ramParts = [{ label: `权重(CPU 侧·fit 卸载)`, gb: offloadFit }, ...ramParts]
      }
    }
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
    kvCacheQuant: config.basic.kv_cache_quant_k || config.basic.kv_cache_quant_v || 'f16',
    nCpuMoe: config.engine === 'llama.cpp' ? config.basic.n_cpu_moe : 0,
    fitEnabled: config.engine === 'llama.cpp' && config.basic.fit_enabled,
    kvmem: { budget: config.kvmem.budget, gen_reserve: config.kvmem.gen_reserve, kv_dtype: config.kvmem.kv_dtype },
    ninfer: { budget: config.ninfer.budget, gen_reserve: config.ninfer.gen_reserve, prefill_chunk: config.ninfer.prefill_chunk, cuda_graph: config.ninfer.cuda_graph, host_kv_mib: config.ninfer.host_kv_mib },
    geom,
  })
}
