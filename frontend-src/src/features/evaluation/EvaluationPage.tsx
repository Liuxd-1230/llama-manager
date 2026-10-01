import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Beaker, FileUp, Play, Plus, ShieldCheck, Target } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { Button, Field, Input, Panel, Select, Switch, Textarea } from '../../components/ui'
import type { DatasetCase, DatasetSummary, Experiment, Provider } from '../../types'
import page from '../pages.module.css'
import styles from './evaluation.module.css'

interface DatasetDetail extends DatasetSummary { cases: DatasetCase[] }

const errText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function EvaluationPage({ toast }: { toast: (text: string) => void }) {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState('')
  const [datasetName, setDatasetName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [expected, setExpected] = useState('')
  const [evaluator, setEvaluator] = useState('exact')
  const [providerId, setProviderId] = useState('local')
  const [model, setModel] = useState('default')
  const [judgeEnabled, setJudgeEnabled] = useState(false)
  const [judgeProvider, setJudgeProvider] = useState('deepseek')
  const [judgeModel, setJudgeModel] = useState('deepseek-chat')
  const [allowCode, setAllowCode] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: () => api<{ datasets: DatasetSummary[] }>('/api/datasets') })
  useEffect(() => { if (!selectedId && datasets.data?.datasets[0]) setSelectedId(datasets.data.datasets[0].id) }, [datasets.data, selectedId])
  const detail = useQuery({ queryKey: ['dataset', selectedId], queryFn: () => api<DatasetDetail>(`/api/datasets/${selectedId}`), enabled: !!selectedId })
  const experiments = useQuery({ queryKey: ['experiments'], queryFn: () => api<{ experiments: Experiment[]; pareto: Experiment[] }>('/api/experiments'), refetchInterval: 4000 })
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<{ providers: Provider[] }>('/api/chat/providers') })
  const invalidate = () => { void queryClient.invalidateQueries({ queryKey: ['datasets'] }); void queryClient.invalidateQueries({ queryKey: ['dataset', selectedId] }) }
  const createDataset = useMutation({ mutationFn: () => api<DatasetSummary>('/api/datasets', { method: 'POST', body: JSON.stringify({ name: datasetName, description: '' }) }), onSuccess: item => { setDatasetName(''); setSelectedId(item.id); invalidate(); toast('数据集已创建') } })
  const addCase = useMutation({ mutationFn: () => api(`/api/datasets/${selectedId}/cases`, { method: 'POST', body: JSON.stringify({ prompt, expected, evaluator: evaluatorBody(evaluator, expected) }) }), onSuccess: () => { setPrompt(''); setExpected(''); invalidate(); toast('测试用例已添加') } })
  const run = useMutation({ mutationFn: () => api('/api/evaluations', { method: 'POST', body: JSON.stringify({ name: `${detail.data?.name || '评测'} · ${model}`, dataset_id: selectedId, provider_id: providerId, model, judge_provider_id: judgeEnabled ? judgeProvider : null, judge_model: judgeEnabled ? judgeModel : null, allow_code_execution: allowCode }) }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['jobs'] }); void queryClient.invalidateQueries({ queryKey: ['experiments'] }); toast('评测任务已进入任务中心') } })
  const importCases = async (file?: File) => { if (!file || !selectedId) return; await api(`/api/datasets/${selectedId}/import`, { method: 'POST', body: JSON.stringify({ format: file.name.endsWith('.csv') ? 'csv' : 'jsonl', content: await file.text() }) }); invalidate(); toast('评测数据已导入') }

  return <div className={styles.layout}>
    {(datasets.isError || experiments.isError) && <p className={page.hint} style={{ gridColumn: '1 / -1', margin: 0, color: 'var(--red)' }}>加载评测数据失败：{errText(datasets.error || experiments.error)}　<Button size="small" onClick={() => invalidate()}>重试</Button></p>}
    <Panel title="数据集" icon={<Target size={15}/>} actions={<Button size="small" onClick={() => importRef.current?.click()}><FileUp size={14}/>导入</Button>}>
      <div className={styles.createRow}><Input value={datasetName} placeholder="新数据集名称" onChange={event => setDatasetName(event.target.value)}/><Button iconOnly title="创建数据集" tone="primary" disabled={!datasetName.trim()} onClick={() => createDataset.mutate()}><Plus size={15}/></Button></div>
      <div className={styles.datasetList}>{(datasets.data?.datasets || []).map(item => <button key={item.id} data-active={item.id === selectedId} onClick={() => setSelectedId(item.id)}><span>{item.name}</span><small>{item.case_count} 个用例{item.builtin ? ' · 内置' : ''}</small></button>)}</div>
      <input ref={importRef} hidden type="file" accept=".jsonl,.csv" onChange={event => { void importCases(event.target.files?.[0]); event.target.value = '' }}/>
    </Panel>
    <div className={page.stack}>
      <Panel title={detail.data?.name || '测试用例'} actions={<span className={styles.meta}>{detail.data?.cases.length || 0} 个用例</span>}>
        <div className={styles.caseForm}><Field label="提示词"><Textarea value={prompt} onChange={event => setPrompt(event.target.value)}/></Field><Field label="预期结果"><Textarea value={expected} onChange={event => setExpected(event.target.value)}/></Field><Field label="评分器"><Select value={evaluator} onChange={event => setEvaluator(event.target.value)}><option value="exact">精确匹配</option><option value="keywords">关键词</option><option value="regex">正则</option><option value="json_schema">JSON Schema</option><option value="command">测试命令</option></Select></Field><Button tone="primary" disabled={!selectedId || !prompt.trim()} onClick={() => addCase.mutate()}><Plus size={14}/>添加用例</Button></div>
        <div className={styles.cases}>{(detail.data?.cases || []).map(item => <div key={item.id}><strong>{item.prompt}</strong><span>{String(item.evaluator.type || 'exact')} · {item.expected || '无固定答案'}</span></div>)}</div>
      </Panel>
      <Panel title="运行评测" icon={<Beaker size={15}/> }>
        <div className={page.formGridThree}><Field label="Provider"><Select value={providerId} onChange={event => setProviderId(event.target.value)}><option value="local">本地 llama.cpp</option>{(providers.data?.providers || []).filter(item => item.id !== 'local').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field><Field label="模型"><Input value={model} onChange={event => setModel(event.target.value)}/></Field><Field label="代码评分"><Switch checked={allowCode} onChange={setAllowCode} label="本次明确授权"/></Field></div>
        <div className={styles.judge}><Switch checked={judgeEnabled} onChange={setJudgeEnabled} label={<><ShieldCheck size={14}/>独立 Judge</>}/>{judgeEnabled && <><Select value={judgeProvider} onChange={event => setJudgeProvider(event.target.value)}>{(providers.data?.providers || []).filter(item => item.id !== 'local').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select><Input value={judgeModel} onChange={event => setJudgeModel(event.target.value)}/></>}</div>
        <Button tone="primary" disabled={!selectedId || run.isPending} onClick={() => run.mutate()}><Play size={15}/>开始评测</Button>
      </Panel>
      <Panel title="实验与 Pareto">
        <div className={styles.pareto}>{(experiments.data?.pareto || []).map(item => <div key={item.id}><strong>{item.model}</strong><span>质量 {format(item.metrics.quality)} · 延迟 {format(item.metrics.avg_latency_ms)}ms · 吞吐 {format(item.metrics.throughput_chars_s)}</span></div>)}</div>
        <table className={page.table}><thead><tr><th>实验</th><th>模型</th><th>状态</th><th>质量</th><th>延迟</th></tr></thead><tbody>{(experiments.data?.experiments || []).map(item => <tr key={item.id}><td>{item.name}</td><td>{item.model}</td><td>{item.status}</td><td>{format(item.metrics.quality)}</td><td>{format(item.metrics.avg_latency_ms)}ms</td></tr>)}</tbody></table>
      </Panel>
    </div>
  </div>
}

function evaluatorBody(type: string, expected: string) { if (type === 'keywords') return { type, keywords: expected.split(/[,，\n]/).filter(Boolean), mode: 'all' }; if (type === 'regex') return { type, pattern: expected }; if (type === 'json_schema') { try { return { type, schema: JSON.parse(expected || '{}') } } catch { return { type, schema: {} } } } if (type === 'command') return { type, command: expected }; return { type } }
function format(value?: number) { return typeof value === 'number' ? Math.round(value * 100) / 100 : '—' }
