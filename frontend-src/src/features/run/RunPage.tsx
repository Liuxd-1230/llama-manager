import { ExternalLink, Play, RefreshCw, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { Badge, Button, Panel } from '../../components/ui'
import { useInterval, useWebSocket } from '../../hooks'
import type { AppConfig } from '../../types'
import page from '../pages.module.css'

interface Status { state: string; pid?: number; uptime_seconds?: number; error?: string }

export function RunPage({ config, toast }: { config: AppConfig; toast: (text: string) => void }) {
  const [status, setStatus] = useState<Status>({ state: 'stopped' })
  const [healthy, setHealthy] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [frameKey, setFrameKey] = useState(0)
  const refresh = useCallback(async () => {
    try {
      setStatus(await api<Status>('/api/server/status'))
      setHealthy((await api<{ ready: boolean }>('/api/server/health')).ready)
    } catch { setHealthy(false) }
  }, [])
  useEffect(() => { void refresh(); api<{ logs: string[] }>('/api/server/logs').then(result => setLogs(result.logs || [])).catch(() => {}) }, [refresh])
  useInterval(() => void refresh(), 3000)
  useWebSocket('/ws/logs', text => setLogs(current => [...current.slice(-1499), text]))
  const serverUrl = useMemo(() => `http://${config.server.host === '0.0.0.0' ? location.hostname : config.server.host}:${config.server.port}`, [config.server])
  const running = status.state === 'running'
  const start = async () => {
    await api('/api/config', { method: 'POST', body: JSON.stringify(config) })
    await api('/api/server/start', { method: 'POST' }); toast('服务器正在启动'); await refresh()
  }
  const stop = async () => { await api('/api/server/stop', { method: 'POST' }); toast('服务器已停止'); await refresh() }
  const clear = async () => { await api('/api/server/logs/clear', { method: 'POST' }); setLogs([]) }

  return <div className={page.stack}>
    <div className={page.statusGrid}>
      <Metric label="状态" value={running ? '运行中' : '已停止'} /><Metric label="健康" value={healthy ? 'Ready' : 'Unavailable'} /><Metric label="PID" value={String(status.pid || '—')} /><Metric label="运行时间" value={formatTime(status.uptime_seconds || 0)} />
    </div>
    <div className={page.grid}>
      <Panel title="进程控制" actions={<Badge tone={healthy ? 'good' : running ? 'warn' : 'neutral'}>{healthy ? '服务可用' : running ? '启动中' : '未运行'}</Badge>}>
        <div className={page.row}><Button tone="success" disabled={running} onClick={() => void start()}><Play size={15}/>启动</Button><Button tone="danger" disabled={!running} onClick={() => void stop()}><Square size={15}/>停止</Button><span className={page.muted}>{serverUrl}</span></div>
        {status.error && <p className={page.hint}>{status.error}</p>}
      </Panel>
      <Panel title="WebUI" actions={<div className={page.row}><Button size="small" onClick={() => setFrameKey(value => value + 1)}><RefreshCw size={14}/>刷新</Button><Button size="small" onClick={() => window.open(serverUrl, '_blank')}><ExternalLink size={14}/>新窗口</Button></div>}>
        <p className={page.hint}>嵌入 llama-server 自带 WebUI；服务就绪后可直接使用。</p>
      </Panel>
    </div>
    <Panel title="实时日志" actions={<Button size="small" onClick={() => void clear()}><Trash2 size={14}/>清空</Button>}>
      <pre className={page.log}>{logs.length ? logs.join('\n') : '等待服务器日志…'}</pre>
    </Panel>
    <Panel title="llama-server WebUI"><iframe key={frameKey} className={page.iframe} src={serverUrl} title="llama-server WebUI" /></Panel>
  </div>
}

function Metric({ label, value }: { label: string; value: string }) { return <div className={page.metric}><strong>{value}</strong><span>{label}</span></div> }
function formatTime(seconds: number) { const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); const s = Math.floor(seconds % 60); return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s` }
