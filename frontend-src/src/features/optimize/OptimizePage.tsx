import { Play, Square } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { Badge, Button, Field, Input, Panel } from '../../components/ui'
import { useInterval, useWebSocket } from '../../hooks'
import page from '../pages.module.css'

interface Result { trial: number; ngl: number; n_cpu_moe: number; ctx: number; kv: string; pp: number; tg: number; score: number }
interface OptimizeStatus { is_running: boolean; current_trial: number; total_trials: number; best?: Result; results: Result[]; logs: string[] }

export function OptimizePage({ toast }: { toast: (text: string) => void }) {
  const [status, setStatus] = useState<OptimizeStatus>({ is_running: false, current_trial: 0, total_trials: 0, results: [], logs: [] })
  const [form, setForm] = useState({ nglMin: 0, nglMax: 99, moeMin: 0, moeMax: 99, contexts: '4096,8192,16384', kv: 'f16,q8_0,q4_0', trials: 30 })
  const refresh = useCallback(async () => { try { setStatus(await api<OptimizeStatus>('/api/optimize/status')) } catch {} }, [])
  useEffect(() => { void refresh() }, [refresh]); useInterval(() => void refresh(), 2500)
  useWebSocket('/ws/optimize', message => { try { const parsed = JSON.parse(message); if (parsed.type === 'status') setStatus(parsed.data); else void refresh() } catch { void refresh() } })
  const start = async () => {
    await api('/api/optimize/start', { method: 'POST', body: JSON.stringify({ ngl_range: [form.nglMin, form.nglMax], n_cpu_moe_range: [form.moeMin, form.moeMax], ctx_options: numbers(form.contexts), kv_options: form.kv.split(',').map(v => v.trim()).filter(Boolean), n_trials: form.trials }) })
    toast('优化任务已启动'); await refresh()
  }
  const stop = async () => { await api('/api/optimize/stop', { method: 'POST' }); toast('正在停止优化') }
  return <div className={page.stack}>
    <Panel title="搜索空间" actions={<Badge tone={status.is_running ? 'warn' : 'neutral'}>{status.is_running ? `${status.current_trial}/${status.total_trials}` : '空闲'}</Badge>}>
      <div className={page.formGridThree}>
        <NumericField label="NGL 最小" value={form.nglMin} set={nglMin => setForm({ ...form, nglMin })}/><NumericField label="NGL 最大" value={form.nglMax} set={nglMax => setForm({ ...form, nglMax })}/>
        <NumericField label="MoE CPU 最小" value={form.moeMin} set={moeMin => setForm({ ...form, moeMin })}/><NumericField label="MoE CPU 最大" value={form.moeMax} set={moeMax => setForm({ ...form, moeMax })}/>
        <Field label="上下文候选"><Input value={form.contexts} onChange={event => setForm({ ...form, contexts: event.target.value })}/></Field>
        <Field label="KV 候选"><Input value={form.kv} onChange={event => setForm({ ...form, kv: event.target.value })}/></Field>
        <NumericField label="试验次数" value={form.trials} set={trials => setForm({ ...form, trials })}/>
      </div>
      <div className={page.row} style={{ marginTop: 14 }}><Button tone="success" disabled={status.is_running} onClick={() => void start()}><Play size={15}/>开始优化</Button><Button tone="danger" disabled={!status.is_running} onClick={() => void stop()}><Square size={15}/>停止</Button></div>
    </Panel>
    <div className={page.grid}>
      <Panel title="当前最优">{status.best ? <div className={page.statusGrid}><Metric label="NGL" value={status.best.ngl}/><Metric label="MoE CPU" value={status.best.n_cpu_moe}/><Metric label="Context" value={status.best.ctx}/><Metric label="TG t/s" value={status.best.tg}/></div> : <div className={page.empty}>尚无有效结果</div>}</Panel>
      <Panel title="优化日志"><pre className={page.code}>{status.logs?.join('\n') || '等待任务…'}</pre></Panel>
    </div>
    <Panel title="试验结果"><div style={{ overflow: 'auto' }}><table className={page.table}><thead><tr><th>#</th><th>NGL</th><th>MoE CPU</th><th>Context</th><th>KV</th><th>PP</th><th>TG</th></tr></thead><tbody>{(status.results || []).map(result => <tr key={result.trial}><td>{result.trial}</td><td>{result.ngl}</td><td>{result.n_cpu_moe}</td><td>{result.ctx}</td><td>{result.kv}</td><td>{result.pp}</td><td>{result.tg}</td></tr>)}</tbody></table></div></Panel>
  </div>
}

function NumericField({ label, value, set }: { label: string; value: number; set: (value: number) => void }) { return <Field label={label}><Input type="number" value={value} onChange={event => set(Number(event.target.value))}/></Field> }
function Metric({ label, value }: { label: string; value: string | number }) { return <div className={page.metric}><strong>{value}</strong><span>{label}</span></div> }
function numbers(value: string) { return value.split(',').map(item => Number(item.trim())).filter(Number.isFinite) }
