import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, FolderPlus, Plus, Search, Settings2, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../api'
import { Button, Field, Input, Panel, Select } from '../../components/ui'
import type { KnowledgeBase } from '../../types'
import page from '../pages.module.css'
import styles from './knowledge.module.css'

interface Detail extends KnowledgeBase { sources: Array<{ id: string; knowledge_base_id: string; path: string; kind: 'file' | 'directory'; status: string; file_count: number; updated_at: number }> }
interface SearchResult { id: string; content: string; source_path: string; page?: number; line_start?: number; line_end?: number; score: number }

const errText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function KnowledgePage({ toast }: { toast: (text: string) => void }) {
  const client = useQueryClient()
  const [selectedId, setSelectedId] = useState('')
  const [name, setName] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [sourceKind, setSourceKind] = useState<'file' | 'directory'>('directory')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const bases = useQuery({ queryKey: ['knowledge-bases'], queryFn: () => api<{ knowledge_bases: KnowledgeBase[] }>('/api/knowledge-bases') })
  useEffect(() => { if (!selectedId && bases.data?.knowledge_bases[0]) setSelectedId(bases.data.knowledge_bases[0].id) }, [bases.data, selectedId])
  const detail = useQuery({ queryKey: ['knowledge-base', selectedId], queryFn: () => api<Detail>(`/api/knowledge-bases/${selectedId}`), enabled: !!selectedId })
  const settings = useQuery({ queryKey: ['embedding-settings'], queryFn: () => api<{ base_url: string; model: string; api_key_env: string; api_key_set: boolean }>('/api/knowledge/settings') })
  useEffect(() => { if (settings.data) { setBaseUrl(settings.data.base_url); setModel(settings.data.model) } }, [settings.data])
  const refresh = () => { void client.invalidateQueries({ queryKey: ['knowledge-bases'] }); void client.invalidateQueries({ queryKey: ['knowledge-base', selectedId] }) }
  const create = useMutation({ mutationFn: () => api<KnowledgeBase>('/api/knowledge-bases', { method: 'POST', body: JSON.stringify({ name, description: '' }) }), onSuccess: item => { setName(''); setSelectedId(item.id); refresh(); toast('知识库已创建') } })
  const addSource = useMutation({ mutationFn: () => api(`/api/knowledge-bases/${selectedId}/sources`, { method: 'POST', body: JSON.stringify({ path: sourcePath, kind: sourceKind }) }), onSuccess: () => { setSourcePath(''); refresh(); toast('来源已添加，点击同步开始索引') } })
  const sync = async (id: string) => { await api(`/api/knowledge-sources/${id}/sync`, { method: 'POST' }); void client.invalidateQueries({ queryKey: ['jobs'] }); toast('索引任务已进入任务中心') }
  const saveSettings = async () => { await api('/api/knowledge/settings', { method: 'PUT', body: JSON.stringify({ base_url: baseUrl, model, api_key_env: 'LLAMA_MANAGER_EMBEDDING_API_KEY' }) }); void client.invalidateQueries({ queryKey: ['embedding-settings'] }); toast('Embedding 设置已保存') }
  const search = async () => { const result = await api<{ results: SearchResult[]; grounded: boolean; latency_ms: number }>('/api/knowledge/search', { method: 'POST', body: JSON.stringify({ knowledge_base_ids: [selectedId], query, limit: 8 }) }, 180000); setResults(result.results); toast(result.grounded ? `检索完成 · ${result.latency_ms}ms` : '未找到足够依据') }
  return <div className={styles.layout}>
    {bases.isError && <p className={page.hint} style={{ gridColumn: '1 / -1', margin: 0, color: 'var(--red)' }}>加载知识库失败：{errText(bases.error)}　<Button size="small" onClick={() => refresh()}>重试</Button></p>}
    <Panel title="知识库" icon={<BookOpen size={15}/> }><div className={styles.createRow}><Input value={name} placeholder="知识库名称" onChange={event => setName(event.target.value)}/><Button iconOnly title="创建" tone="primary" disabled={!name.trim()} onClick={() => create.mutate()}><Plus size={15}/></Button></div><div className={styles.baseList}>{(bases.data?.knowledge_bases || []).map(item => <button key={item.id} data-active={item.id === selectedId} onClick={() => setSelectedId(item.id)}><span>{item.name}</span><small>{item.source_count} 来源 · {item.chunk_count} 分块</small></button>)}</div></Panel>
    <div className={page.stack}>
      <Panel title="Embedding 端点" icon={<Settings2 size={15}/>} actions={<span className={styles.status}>{settings.data?.api_key_set ? '环境 Key 已配置' : `可选：${settings.data?.api_key_env || 'LLAMA_MANAGER_EMBEDDING_API_KEY'}`}</span>}><div className={page.formGrid}><Field label="Base URL"><Input value={baseUrl} placeholder="http://127.0.0.1:8081/v1" onChange={event => setBaseUrl(event.target.value)}/></Field><Field label="Embedding 模型"><Input value={model} onChange={event => setModel(event.target.value)}/></Field></div><Button style={{ marginTop: 10 }} onClick={() => void saveSettings()}>保存设置</Button></Panel>
      <Panel title={detail.data?.name || '资料来源'} icon={<FolderPlus size={15}/> }><div className={styles.sourceForm}><Input value={sourcePath} placeholder="文件或目录的绝对路径" onChange={event => setSourcePath(event.target.value)}/><Select value={sourceKind} onChange={event => setSourceKind(event.target.value as 'file' | 'directory')}><option value="directory">目录</option><option value="file">文件</option></Select><Button tone="primary" disabled={!selectedId || !sourcePath.trim()} onClick={() => addSource.mutate()}><Plus size={14}/>添加</Button></div><div className={styles.sources}>{(detail.data?.sources || []).map(source => <div key={source.id}><div><strong>{source.path}</strong><small>{source.kind} · {source.file_count} 文件 · {source.status}</small></div><Button size="small" onClick={() => void sync(source.id)}>同步</Button><Button iconOnly size="small" title="删除来源" tone="danger" onClick={async () => { await api(`/api/knowledge-sources/${source.id}`, { method: 'DELETE' }); refresh() }}><Trash2 size={13}/></Button></div>)}</div></Panel>
      <Panel title="检索调试" icon={<Search size={15}/> }><div className={styles.searchRow}><Input value={query} placeholder="输入问题，查看召回片段与引用位置" onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void search() }}/><Button disabled={!selectedId || !query.trim()} onClick={() => void search()}><Search size={14}/>检索</Button></div><div className={styles.results}>{results.map(item => <article key={item.id}><header><strong>{item.source_path}</strong><span>{item.page ? `p.${item.page}` : `L${item.line_start || '?'}-${item.line_end || '?'}`}</span></header><p>{item.content}</p></article>)}</div></Panel>
    </div>
  </div>
}
