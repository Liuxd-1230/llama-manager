import { ExternalLink, Maximize2, Minimize2, Play, RefreshCw, Square, Trash2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { Badge, Button } from '../../components/ui'
import { useInterval, useWebSocket } from '../../hooks'
import type { AppConfig } from '../../types'
import page from '../pages.module.css'
import styles from './run.module.css'

interface Status { state: string; pid?: number; uptime_seconds?: number; error?: string }

export function RunPage({ config, toast }: { config: AppConfig; toast: (text: string) => void }) {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<Status>({ state: 'stopped' })
  const [healthy, setHealthy] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [frameKey, setFrameKey] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const refresh = useCallback(async () => {
    try {
      setStatus(await api<Status>('/api/server/status'))
      setHealthy((await api<{ ready: boolean }>('/api/server/health')).ready)
    } catch { setHealthy(false) }
  }, [])
  useEffect(() => { void refresh(); api<{ logs: string[] }>('/api/server/logs').then(result => setLogs(result.logs || [])).catch(() => {}) }, [refresh])
  useInterval(() => void refresh(), 3000)
  useWebSocket('/ws/logs', text => setLogs(current => [...current.slice(-1499), text]))
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setFullscreen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])
  const serverUrl = useMemo(() => `http://${config.server.host === '0.0.0.0' ? location.hostname : config.server.host}:${config.server.port}`, [config.server])
  const running = status.state === 'running'
  const start = async () => {
    await api('/api/config', { method: 'POST', body: JSON.stringify(config) })
    // The POST just made the server state match this buffer — refresh the
    // cache so the topbar dirty badge does not linger as a false positive.
    await queryClient.invalidateQueries({ queryKey: ['config'] })
    await api('/api/server/start', { method: 'POST' }); toast('服务器正在启动'); await refresh()
  }
  const stop = async () => { await api('/api/server/stop', { method: 'POST' }); toast('服务器已停止'); await refresh() }
  const clear = async () => { await api('/api/server/logs/clear', { method: 'POST' }); setLogs([]) }

  return <div className={styles.shell}>
    <div className={styles.controlRow}>
      <Button tone="success" disabled={running} onClick={() => void start()}><Play size={15}/>启动</Button>
      <Button tone="danger" disabled={!running} onClick={() => void stop()}><Square size={15}/>停止</Button>
      <Badge tone={healthy ? 'good' : running ? 'warn' : 'neutral'}>{healthy ? '服务可用' : running ? '启动中' : '未运行'}</Badge>
      <span className={styles.statusDot}>{running ? `PID ${status.pid || '—'} · ${formatTime(status.uptime_seconds || 0)}` : '已停止'}</span>
      <span className={page.muted}>{serverUrl}</span>
      {status.error && <span className={page.hint}>{status.error}</span>}
      <div className={page.row} style={{ marginLeft: 'auto' }}>
        <Button size="small" onClick={() => setFrameKey(value => value + 1)}><RefreshCw size={14}/>刷新</Button>
        <Button size="small" onClick={() => window.open(serverUrl, '_blank')}><ExternalLink size={14}/>新窗口</Button>
        <Button size="small" onClick={() => setFullscreen(true)}><Maximize2 size={14}/>全屏</Button>
      </div>
    </div>
    <div className={`${styles.webuiBox} ${fullscreen ? styles.fullscreen : ''}`}>
      <iframe key={frameKey} src={serverUrl} title="llama-server WebUI" />
      {!running && <div className={styles.overlay}><div><p style={{ margin: 0 }}>服务未启动。</p><p className={page.hint}>在「模型」页或上方启动后，此处按当前引擎显示自带 WebUI（llama.cpp 或 KVMem）。</p></div></div>}
      {fullscreen && <Button className={styles.exitButton} iconOnly title="退出全屏 (Esc)" onClick={() => setFullscreen(false)}><Minimize2 size={16}/></Button>}
    </div>
    <details>
      <summary className={styles.statusDot} style={{ cursor: 'pointer' }}>实时日志</summary>
      <div className={page.row} style={{ justifyContent: 'flex-end' }}><Button size="small" onClick={() => void clear()}><Trash2 size={14}/>清空</Button></div>
      <pre className={page.log}>{logs.length ? logs.join('\n') : '等待服务器日志…'}</pre>
    </details>
  </div>
}

function formatTime(seconds: number) { const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); const s = Math.floor(seconds % 60); return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s` }
