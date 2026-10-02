import { AlertTriangle, Download, Globe, Hammer, RefreshCw, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { Badge, Button, Field, Input, Panel, Textarea } from '../../components/ui'
import { useInterval, useWebSocket } from '../../hooks'
import type { AppConfig } from '../../types'
import page from '../pages.module.css'

interface MirrorCandidate { id: string; name: string; prefix: string; ok: boolean; latency_ms: number | null }

function LogTerminal({ text, empty }: { text: string; empty: string }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [text])
  return <pre ref={ref} className={page.log}>{text || empty}</pre>
}

export function MaintenancePage({ config, setConfig, toast }: { config: AppConfig; setConfig: (config: AppConfig) => void; toast: (text: string) => void }) {
  const [downloadDir, setDownloadDir] = useState('')
  const [downloadLogs, setDownloadLogs] = useState<string[]>([])
  const [compileLogs, setCompileLogs] = useState<string[]>([])
  const [updateInfo, setUpdateInfo] = useState('尚未检查更新')
  const [pullOutput, setPullOutput] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [compiling, setCompiling] = useState(false)
  const [mirrors, setMirrors] = useState<MirrorCandidate[]>([])
  const [probing, setProbing] = useState(false)
  const [mirror, setMirror] = useState(() => localStorage.getItem('github-mirror') || '')
  const selectMirror = (prefix: string) => { setMirror(prefix); localStorage.setItem('github-mirror', prefix) }
  const probeMirrors = async () => {
    setProbing(true)
    try {
      const result = await api<{ mirrors: MirrorCandidate[] }>('/api/mirrors', {}, 20000)
      setMirrors(result.mirrors || [])
      const best = (result.mirrors || []).find(item => item.ok)
      if (best && !localStorage.getItem('github-mirror')) { setMirror(best.prefix); localStorage.setItem('github-mirror', best.prefix) }
    } catch { toast('镜像探测失败') } finally { setProbing(false) }
  }
  useWebSocket('/ws/download', message => setDownloadLogs(logs => [...logs.slice(-999), message]))
  useWebSocket('/ws/compile', message => setCompileLogs(logs => [...logs.slice(-999), message]))
  // Reconcile busy flags with server truth: without this a finished or failed
  // task leaves the buttons permanently disabled until a page reload.
  useInterval(() => {
    void api<{ is_compiling: boolean }>('/api/update/compile/logs').then(result => setCompiling(Boolean(result.is_compiling))).catch(() => {})
    void api<{ is_downloading: boolean }>('/api/download/status').then(result => setDownloading(Boolean(result.is_downloading))).catch(() => {})
  }, 3000)
  const download = async () => { if (!downloadDir) return toast('请输入下载目录'); setDownloading(true); await api('/api/download/start', { method: 'POST', body: JSON.stringify({ target_dir: downloadDir }) }); toast('下载已启动') }
  const stopDownload = async () => { await api('/api/download/stop', { method: 'POST' }); setDownloading(false) }
  const check = async () => { const result = await api<{ has_update: boolean; current_commit: string; remote_commit: string; error?: string }>(`/api/update/check?llama_cpp_dir=${encodeURIComponent(config.llama_cpp_dir)}&mirror=${encodeURIComponent(mirror)}`, {}, 300000); setUpdateInfo(result.error ? `检查失败：${result.error}` : result.has_update ? `有更新：${result.current_commit} → ${result.remote_commit}` : `已是最新：${result.current_commit}`) }
  const pull = async (force = false) => { const result = await api<{ success?: boolean; output?: string; error?: string }>('/api/update/pull', { method: 'POST', body: JSON.stringify({ force, mirror }) }, 600000); setUpdateInfo(result.output || result.error || '操作完成'); setPullOutput(result.output || result.error || '') }
  const compile = async () => { setCompiling(true); await api('/api/config', { method: 'POST', body: JSON.stringify(config) }); await api('/api/update/compile', { method: 'POST' }); toast('编译已启动') }
  const stopCompile = async () => { await api('/api/update/compile/stop', { method: 'POST' }); setCompiling(false) }
  return <div className={page.stack}>
    {config.engine === 'kvmem' && <p className={page.hint} style={{ margin: 0 }}>当前档案使用 KVMem 引擎（预编译包，非 git 仓库）：检查更新、拉取和编译不适用，仅「下载 llama.cpp」可用。</p>}
    <div className={page.grid}>
      <Panel title="下载 llama.cpp" icon={<Download size={15}/>}>
        <Field label="目标目录"><Input value={downloadDir} onChange={event => setDownloadDir(event.target.value)} placeholder="D:\\workspace\\llama.cpp"/></Field>
        <div className={page.row} style={{ marginTop: 12 }}><Button tone="primary" disabled={downloading} onClick={() => void download()}><Download size={15}/>下载</Button><Button tone="danger" disabled={!downloading} onClick={() => void stopDownload()}><Square size={15}/>停止</Button></div>
        <pre className={page.code}>{downloadLogs.join('\n') || '等待下载任务…'}</pre>
      </Panel>
      <Panel title="更新源码" icon={<RefreshCw size={15}/>}>
        <p>{updateInfo}</p><div className={page.wrap}><Button onClick={() => void check()}><RefreshCw size={15}/>检查更新</Button><Button tone="primary" onClick={() => void pull(false)}><Download size={15}/>拉取更新</Button><Button tone="danger" onClick={() => void pull(true)}><AlertTriangle size={15}/>强制重置</Button></div>
        <p className={page.hint}>强制重置会覆盖 llama.cpp 目录中的本地修改。</p>
        <div className={page.row} style={{ marginTop: 10 }}><Button size="small" onClick={() => void probeMirrors()} disabled={probing}><Globe size={14}/>{probing ? '探测中…' : '探测 GitHub 镜像'}</Button><span className={page.hint}>{mirror === '' ? '当前：GitHub 直连' : '当前：自定义镜像前缀'}</span></div>
        {mirrors.length > 0 && <div className={page.wrap} style={{ marginTop: 8 }}>{mirrors.map(item => <Button key={item.id} size="small" tone={mirror === item.prefix ? 'primary' : 'default'} onClick={() => selectMirror(item.prefix)}><Globe size={13}/>{item.name}{item.ok ? ` · ${item.latency_ms}ms` : ' · 不可用'}</Button>)}</div>}
        {mirrors.length > 0 && <p className={page.hint}>延迟为 git 握手实测；点击选用，仅影响拉取，不改变仓库 origin 配置。</p>}
        <LogTerminal text={pullOutput} empty="等待拉取输出…" />
      </Panel>
    </div>
    <Panel title="编译" icon={<Hammer size={15}/>} actions={<div className={page.row}><Button tone="success" disabled={compiling} onClick={() => void compile()}><Hammer size={15}/>开始编译</Button><Button tone="danger" disabled={!compiling} onClick={() => void stopCompile()}><Square size={15}/>停止</Button></div>}>
      <Field label="编译命令"><Textarea value={config.compile.command} onChange={event => setConfig({ ...config, compile: { ...config.compile, command: event.target.value } })}/></Field>
      <p className={page.hint}>在当前档案的引擎目录内执行；「开始编译」会先自动保存当前配置。仅对 git 源码检出有意义，预编译包无需编译。</p>
      <LogTerminal text={compileLogs.join('\n')} empty="等待编译任务…" />
    </Panel>
  </div>
}
