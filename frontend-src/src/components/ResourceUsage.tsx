import type { UsageEstimate } from '../utils/vram'
import styles from './ResourceUsage.module.css'

export function ResourceUsage({ usage, compact = false }: { usage: UsageEstimate; compact?: boolean }) {
  const scaleGb = Math.max(8, usage.vram.totalGb)
  return <div className={styles.resource} data-compact={compact}>
    <div className={styles.heading}><span>预计显存</span><span><strong data-over={usage.vram.over}>{usage.vram.totalGb.toFixed(2)}</strong><span className={styles.unit}> / 8 GB</span></span></div>
    <div className={styles.capacity} role="img" aria-label={`预计显存 ${usage.vram.totalGb.toFixed(2)} GB，安全线 7.4 GB，总容量 8 GB`}>
      {usage.vram.parts.map((part, index) => <span key={part.label} title={`${part.label} ${part.gb.toFixed(2)} GB`} style={{ width: `${Math.max(0, part.gb / scaleGb * 100)}%` }} data-part={index % 4}/>)}
      <i className={styles.limit} style={{ left: `${7.4 / scaleGb * 100}%` }} title="7.4 GB 安全线"/>
    </div>
    <div className={styles.legend}>{usage.vram.parts.map((part, index) => <span key={part.label}><i data-part={index % 4}/>{part.label}<b>{part.gb.toFixed(2)}</b></span>)}</div>
    <div className={styles.note}><span>内存估算 {usage.ram.totalGb.toFixed(1)} GB</span><span data-over={usage.vram.over}>{usage.vram.over ? '超过 7.4 GB 安全线' : '显存安全线 7.4 GB'}</span></div>
    {!compact && <p className={styles.explanation}>基于模型几何与 Bonsai 27B 实测系数估算，实际占用以运行结果为准。超过安全线可能启动失败或显存不足。</p>}
  </div>
}
