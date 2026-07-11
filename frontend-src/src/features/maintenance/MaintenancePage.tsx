import { AlertTriangle, Download, Hammer, RefreshCw, Square } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../api'
import { Button, Field, Input, Panel } from '../../components/ui'
import { useWebSocket } from '../../hooks'
import type { AppConfig } from '../../types'
import page from '../pages.module.css'

export function MaintenancePage({ config, toast }: { config: AppConfig; toast: (text: string) => void }) {
  const [downloadDir, setDownloadDir] = useState('')
  const [downloadLogs, setDownloadLogs] = useState<string[]>([])
  const [compileLogs, setCompileLogs] = useState<string[]>([])
  const [updateInfo, setUpdateInfo] = useState('尚未检查更新')
  const [downloading, setDownloading] = useState(false)
  const [compiling, setCompiling] = useState(false)
  useWebSocket('/ws/download', message => setDownloadLogs(logs => [...logs.slice(-999), message]))
  useWebSocket('/ws/compile', message => setCompileLogs(logs => [...logs.slice(-999), message]))
  const download = async () => { if (!downloadDir) return toast('请输入下载目录'); setDownloading(true); await api('/api/download/start', { method: 'POST', body: JSON.stringify({ target_dir: downloadDir }) }); toast('下载已启动') }
  const stopDownload = async () => { await api('/api/download/stop', { method: 'POST' }); setDownloading(false) }
  const check = async () => { const result = await api<{ has_update: boolean; current_commit: string; remote_commit: string }>('/api/update/check'); setUpdateInfo(result.has_update ? `有更新：${result.current_commit} → ${result.remote_commit}` : `已是最新：${result.current_commit}`) }
  const pull = async (force = false) => { const result = await api<{ success?: boolean; output?: string; error?: string }>('/api/update/pull', { method: 'POST', body: JSON.stringify({ force }) }); setUpdateInfo(result.output || result.error || '操作完成') }
  const compile = async () => { setCompiling(true); await api('/api/config', { method: 'POST', body: JSON.stringify(config) }); await api('/api/update/compile', { method: 'POST' }); toast('编译已启动') }
  const stopCompile = async () => { await api('/api/update/compile/stop', { method: 'POST' }); setCompiling(false) }
  return <div className={page.stack}>
    <div className={page.grid}>
      <Panel title="下载 llama.cpp" icon={<Download size={15}/>}>
        <Field label="目标目录"><Input value={downloadDir} onChange={event => setDownloadDir(event.target.value)} placeholder="D:\\workspace\\llama.cpp"/></Field>
        <div className={page.row} style={{ marginTop: 12 }}><Button tone="primary" disabled={downloading} onClick={() => void download()}><Download size={15}/>下载</Button><Button tone="danger" disabled={!downloading} onClick={() => void stopDownload()}><Square size={15}/>停止</Button></div>
        <pre className={page.code}>{downloadLogs.join('\n') || '等待下载任务…'}</pre>
      </Panel>
      <Panel title="更新源码" icon={<RefreshCw size={15}/>}>
        <p>{updateInfo}</p><div className={page.wrap}><Button onClick={() => void check()}><RefreshCw size={15}/>检查更新</Button><Button tone="primary" onClick={() => void pull(false)}><Download size={15}/>拉取更新</Button><Button tone="danger" onClick={() => void pull(true)}><AlertTriangle size={15}/>强制重置</Button></div>
        <p className={page.hint}>强制重置会覆盖 llama.cpp 目录中的本地修改。</p>
      </Panel>
    </div>
    <Panel title="编译" icon={<Hammer size={15}/>} actions={<div className={page.row}><Button tone="success" disabled={compiling} onClick={() => void compile()}><Hammer size={15}/>开始编译</Button><Button tone="danger" disabled={!compiling} onClick={() => void stopCompile()}><Square size={15}/>停止</Button></div>}>
      <pre className={page.log}>{compileLogs.join('\n') || '等待编译任务…'}</pre>
    </Panel>
  </div>
}
