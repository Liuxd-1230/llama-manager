import { PathPicker } from '../../components/PathPicker'
import { isComposingKey } from '../../hooks/useImeGuard'
import { useQuery,useQueryClient } from '@tanstack/react-query'
import { ArrowRight,Copy,Download,Loader2,Search,SlidersHorizontal } from 'lucide-react'
import { useMemo,useState } from 'react'
import { api } from '../../api'
import { Button,Field,Input,Select } from '../../components/kit'
import styles from './atelier.module.css'


import { bytes,errorText,request,type Job,type Toast } from './atelierApi'
import { JobList } from './Jobs'
import { Empty,ErrorNotice } from './ResourceFeedback'

interface RepoFile { path: string; size: number | null; category: string }
interface Repo { repo_id: string; revision: string; filename: string; files: RepoFile[] }
export function DownloadsPage({ toast }: { toast: Toast }) {
  const client = useQueryClient()
  const [url, setUrl] = useState('')
  const [endpoint, setEndpoint] = useState('https://hf-mirror.com')
  const [repo, setRepo] = useState<Repo | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [category, setCategory] = useState('全部')
  const [mode, setMode] = useState('local_dir')
  const [directory, setDirectory] = useState('')
  const [workers, setWorkers] = useState('4')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tokenValue, setTokenValue] = useState('')
  const [settings, setSettings] = useState(false)
  const [history, setHistory] = useState(false)
  const [sort, setSort] = useState<'path' | 'size'>('path')
  const [preview, setPreview] = useState<{ command: string; free_bytes: number } | null>(null)
  const tokenState = useQuery({ queryKey: ['hf-token'], queryFn: () => api<{ configured: boolean }>('/api/v1/downloads/token') })
  const jobs = useQuery({ queryKey: ['atelier-jobs'], queryFn: () => api<Job[]>('/api/v1/jobs'), refetchInterval: 1500 })
  const historyQuery = useQuery({ queryKey: ['download-history'], queryFn: () => api<any[]>('/api/v1/downloads/history'), enabled: history, refetchInterval: history ? 5000 : false })
  const visible = useMemo(() => {
    const patterns = filter.toLowerCase().split(/[\s,，]+/).filter(Boolean)
    const glob = (pattern: string, name: string) => pattern.includes('*') || pattern.includes('?') ? new RegExp('^' + pattern.split('*').map(part => part.split('?').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.')).join('.*') + '$').test(name) : name.includes(pattern)
    return (repo?.files || []).filter(file => (category === '全部' || file.category === category) && (!patterns.length || patterns.some(pattern => glob(pattern, file.path.toLowerCase())))).sort((a, b) => sort === 'path' ? a.path.localeCompare(b.path) : (b.size || 0) - (a.size || 0))
  }, [repo, filter, category, sort])
  const inspect = async () => { setBusy(true); setError(''); try { const r = await request<Repo>('/downloads/inspect', { input: url, endpoint }); setRepo(r); setSelected(r.filename ? [r.filename] : []); setPreview(null) } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }
  const body = () => ({ repo_id: repo?.repo_id, revision: repo?.revision, endpoint, files: selected, mode, directory, workers: Number(workers) })
  const start = async () => { setBusy(true); try { await request('/downloads', body()); toast('下载已加入任务队列'); await client.invalidateQueries({ queryKey: ['atelier-jobs'] }) } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }
  return <div className={styles.workspace}>
    <div className={styles.pageHeading}><div><h1>下载</h1><p>从远处的模型仓库，到你手边的工作台。</p></div><Button onClick={() => setSettings(!settings)}><SlidersHorizontal size={16} />下载设置</Button><Button onClick={() => setHistory(!history)}>{history ? '返回文件' : '下载历史'}</Button></div>
    {settings && <section className={styles.settingsStrip}><Field label="下载源"><Select value={endpoint} onChange={e => { setEndpoint(e.target.value); setRepo(null) }}><option>https://hf-mirror.com</option><option>https://hf-mirror.net</option><option>https://huggingface.co</option></Select></Field><Field label={`HF Token${tokenState.data?.configured ? ' · 已保存' : ' · 可选'}`}><Input type="password" autoComplete="off" placeholder="仅用于受限或私有仓库" value={tokenValue} onChange={e => setTokenValue(e.target.value)} /></Field><Button onClick={async () => { try { await request('/downloads/token', { token: tokenValue }, 'PUT'); setTokenValue(''); void client.invalidateQueries({ queryKey: ['hf-token'] }); toast('Token 已加密保存') } catch (e) { toast(errorText(e)) } }}>保存 Token</Button><Button onClick={async () => { try { const r = await request<any>('/downloads/mirror-test', { input: 'test', endpoint }); toast(JSON.stringify(r)) } catch (e) { toast(errorText(e)) } }}>检测镜像</Button></section>}
    <div className={styles.repoInput}><Search size={20} /><Input aria-label="Hugging Face 仓库链接" placeholder="粘贴仓库或文件链接，也支持 owner/repo@revision" value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !isComposingKey(e.nativeEvent)) void inspect() }} /><Button disabled={busy || !url.trim()} onClick={() => void inspect()}>{busy ? <Loader2 size={16} className="spin" /> : <ArrowRight size={16} />}解析仓库</Button></div>
    <ErrorNotice error={error} />
    {history ? <div className={styles.tableWrap}><table><thead><tr><th>仓库 / 文件</th><th>保存位置</th><th>状态</th><th /></tr></thead><tbody>{historyQuery.data?.map(row => <tr key={row.id}><td><strong>{row.filename}</strong><small>{row.repo_id}</small></td><td className={styles.path}>{row.local_path}</td><td>{row.status}</td><td><Button onClick={() => { setUrl(`${row.repo_id}@${row.revision || 'main'}`); setDirectory(row.local_path?.replace(/[\\/][^\\/]+$/, '') || ''); setHistory(false) }}>重新下载</Button></td></tr>)}</tbody></table><ErrorNotice error={historyQuery.error} /></div> : repo ? <div className={styles.downloadColumns}><section><div className={styles.sectionTitle}><h2>{repo.repo_id}</h2><span>{repo.revision} · {repo.files.length} 个文件</span></div><div className={styles.toolbar}><Input aria-label="筛选文件" placeholder="文件名或通配符，如 *Q4_K_M*.gguf" value={filter} onChange={e => setFilter(e.target.value)} /><Select aria-label="文件类型" value={category} onChange={e => setCategory(e.target.value)}>{['全部', 'GGUF', 'Safetensors', 'LiteRT', 'ZIP', '配置文件', '其他'].map(x => <option key={x}>{x}</option>)}</Select></div>
      <div className={styles.tableWrap}><table><thead><tr><th><input type="checkbox" aria-label="选择全部可见文件" checked={visible.length > 0 && visible.every(f => selected.includes(f.path))} onChange={e => setSelected(e.target.checked ? [...new Set([...selected, ...visible.map(f => f.path)])] : selected.filter(name => !visible.some(f => f.path === name)))} /></th><th><button onClick={() => setSort('path')}>文件路径</button></th><th><button onClick={() => setSort('size')}>大小</button></th></tr></thead><tbody>{visible.map(file => <tr key={file.path}><td><input type="checkbox" aria-label={`选择 ${file.path}`} checked={selected.includes(file.path)} onChange={e => setSelected(e.target.checked ? [...selected, file.path] : selected.filter(x => x !== file.path))} /></td><td className={styles.path}>{file.path}</td><td className={styles.number}>{bytes(file.size)}</td></tr>)}</tbody></table>{!visible.length && <Empty title="没有匹配的文件">试试其他文件名或文件类型。</Empty>}</div></section>
      <aside className={styles.downloadOptions}><h2>放到哪里</h2><Field label="保存方式"><Select value={mode} onChange={e => setMode(e.target.value)}><option value="local_dir">指定目录 · 即下即用</option><option value="cache">HF 缓存 · snapshots 结构</option></Select></Field><Field label="目标目录"><PathPicker value={directory} onChange={setDirectory} /></Field><Field label="并发文件数"><Select value={workers} onChange={e => setWorkers(e.target.value)}>{[1, 2, 4, 8].map(x => <option key={x}>{x}</option>)}</Select></Field><div className={styles.selectionSummary}><strong>{selected.length}</strong><span>个文件已选择</span><b>{bytes(repo.files.filter(f => selected.includes(f.path)).reduce((sum, f) => sum + (f.size || 0), 0))}</b></div><Button tone="primary" disabled={busy || !selected.length || !directory} onClick={() => void start()}><Download size={16} />开始下载</Button><Button disabled={!selected.length || !directory} onClick={async () => { try { setPreview(await request('/downloads/preview', body())) } catch (e) { setError(errorText(e)) } }}>查看空间与等价命令</Button>{preview && <div className={styles.command}><p>磁盘可用 {bytes(preview.free_bytes)}</p><code>{preview.command}</code><Button onClick={() => { void navigator.clipboard.writeText(preview.command); toast('命令已复制') }}><Copy size={14} />复制命令</Button></div>}</aside></div> : <Empty title="从一个链接开始">解析仓库后，可以筛选文件、比较大小，再选择下载位置。文件不会自动下载。</Empty>}
    <div className={styles.sectionTitle}><h2>下载队列</h2><span>关闭页面不会停止下载</span></div><JobList jobs={(jobs.data || []).filter(j => j.kind === 'download')} toast={toast} />
  </div>
}
