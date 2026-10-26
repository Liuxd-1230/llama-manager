import { describe, expect, it } from 'vitest'
import { estimateUsage, type VramInput } from './vram'

// 校准事实(注释里的本机实测,nvidia-smi deltas 2026-10-06)以断言形式钉死:
//  - llama.cpp f16 KV 斜率 ≈31.7KB/token,几何公式差 <1%
//  - q4 KV = f16 × 0.47(15.1/32 校准)
//  - scratch = 权重×(-0.12)+1.6,下限 0
//  - KVMem 非 KV 基线 5.36GB(含桌面),engine 侧 4.36
//  - MoE:专家字节 ≈ 文件 94%,GPU 侧权重下限 6%
const GB = 1024
const f16Tok = 32512 // ≈31.75KB/token,27B 级几何典型值

function base(over: Partial<VramInput>): VramInput {
  return {
    engine: 'llama.cpp',
    modelSizeMb: 0,
    ctxSize: 8192,
    kvCacheQuant: 'f16',
    kvmem: { budget: 8192, gen_reserve: 512, kv_dtype: 'q4_0' },
    ninfer: { budget: 8192, gen_reserve: 512, prefill_chunk: 256, cuda_graph: false, host_kv_mib: 0 },
    ...over,
  }
}

describe('vram estimator — llama.cpp', () => {
  it('weights + KV + calibrated scratch sum to the golden total', () => {
    const r = estimateUsage(base({ modelSizeMb: 5900, geom: { kv_bytes_per_token_f16: f16Tok } }))
    const kv = Math.round((f16Tok * 8192) / GB / GB / GB * 100) / 100
    const scratch = Math.max(0, (5900 / GB) * -0.12 + 1.6)
    expect(r.vram.parts.map(p => p.label)).toEqual(['桌面', '权重', `KV(全量 8K)`, '计算/分配缓冲'])
    expect(r.vram.totalGb).toBeCloseTo(1 + 5900 / GB + kv + Math.round(scratch * 100) / 100, 2)
    expect(r.ram.totalGb).toBeCloseTo(5900 / GB + 0.6, 2)
  })

  it('scratch floors at zero for large models', () => {
    const r = estimateUsage(base({ modelSizeMb: 16 * GB, geom: { kv_bytes_per_token_f16: f16Tok } }))
    expect(r.vram.parts.at(-1)!.gb).toBe(0)
  })
})

describe('vram estimator — kvmem', () => {
  it('applies the q4 factor to the f16 geometry (≈15.1KB/token on 32KB f16)', () => {
    const r = estimateUsage(base({ engine: 'kvmem', modelSizeMb: 15 * GB, kvmem: { budget: 8192, gen_reserve: 512, kv_dtype: 'q4_0' }, geom: { kv_bytes_per_token_f16: 32768 } }))
    const kvPart = r.vram.parts.find(p => p.label.startsWith('KV'))
    expect(kvPart!.gb).toBeCloseTo((32768 * 0.47 * 8704) / GB ** 3, 2)
    expect(kvPart!.gb).toBeGreaterThanOrEqual(0.12)
  })

  it('engine-side base shrinks as GPU weights grow', () => {
    const thin = estimateUsage(base({ engine: 'kvmem', modelSizeMb: 4 * GB }))
    const fat = estimateUsage(base({ engine: 'kvmem', modelSizeMb: 6 * GB }))
    const thinBuf = thin.vram.parts.find(p => p.label === '缓冲(实测)')!
    const fatBuf = fat.vram.parts.find(p => p.label === '缓冲(实测)')!
    expect(thinBuf.gb).toBeCloseTo(5.36 - 1 - 4, 2)
    expect(fatBuf.gb).toBe(0)
  })
})

describe('vram estimator — MoE expert offload (Hermes 35B-A3B calibration)', () => {
  it('moves ~94%-share expert layers to RAM and keeps a 6% GPU floor', () => {
    const r = estimateUsage(base({ modelSizeMb: 20 * GB, nCpuMoe: 40, geom: { kv_bytes_per_token_f16: f16Tok, experts: 8, moe_layers: 47 } }))
    const gpu = r.vram.parts.find(p => p.label === '权重(GPU 侧)')!
    const cpu = r.ram.parts.find(p => p.label.includes('CPU 专家'))!
    const perLayer = (20 * 0.94) / 47
    expect(gpu.gb).toBeCloseTo(20 - 40 * perLayer, 1)
    expect(cpu.gb).toBeCloseTo(40 * perLayer, 1)
  })

  it('never offloads below 6% of weights', () => {
    const r = estimateUsage(base({ modelSizeMb: 10 * GB, nCpuMoe: 60, geom: { kv_bytes_per_token_f16: f16Tok, experts: 8, moe_layers: 47 } }))
    const gpu = r.vram.parts.find(p => p.label === '权重(GPU 侧)')!
    expect(gpu.gb).toBeCloseTo(0.6, 2)
  })
})

describe('vram estimator — units and budget threshold', () => {
  it('converts bytes to GB with the 1024³ divisor (2a97f8b guard)', () => {
    const r = estimateUsage(base({ ctxSize: 1, geom: { kv_bytes_per_token: GB ** 3 } }))
    expect(r.vram.parts.find(p => p.label.startsWith('KV'))!.gb).toBe(1)
  })

  it('flags over-budget only above 7.4 GB', () => {
    // 1(桌面) + w(权重) + kv(1K×32KB≈0.03) + scratch(w) — 解出 w 使总额跨 7.4
    const around = (w: number) => estimateUsage(base({ modelSizeMb: w * GB, ctxSize: 1024, geom: { kv_bytes_per_token_f16: 32768 } })).vram.totalGb
    const justUnder = around(5.35)
    const justOver = around(5.45)
    expect(justUnder).toBeLessThanOrEqual(7.4)
    expect(justOver).toBeGreaterThan(7.4)
    expect(estimateUsage(base({ modelSizeMb: 5.35 * GB, ctxSize: 1024, geom: { kv_bytes_per_token_f16: 32768 } })).vram.over).toBe(false)
    expect(estimateUsage(base({ modelSizeMb: 5.45 * GB, ctxSize: 1024, geom: { kv_bytes_per_token_f16: 32768 } })).vram.over).toBe(true)
  })
})
