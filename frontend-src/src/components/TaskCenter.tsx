import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CircleStop, Clock3, RefreshCw, RotateCcw, X, XCircle } from 'lucide-react'
import { useEffect } from 'react'
import { api, wsUrl } from '../api'
import type { JobRecord } from '../types'
import { Badge, Button } from './ui'
import styles from './TaskCenter.module.css'

export function TaskCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => api<JobRecord[]>('/api/jobs'), enabled: open, refetchInterval: open ? 3000 : false })
  const action = useMutation({ mutationFn: ({ id, name }: { id: string; name: 'cancel' | 'retry' }) => api<JobRecord>(`/api/jobs/${id}/${name}`, { method: 'POST' }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }) })
  useEffect(() => {
    const socket = new WebSocket(wsUrl('/ws/jobs'))
    socket.onmessage = () => { void queryClient.invalidateQueries({ queryKey: ['jobs'] }) }
    return () => socket.close()
  }, [queryClient])
  if (!open) return null
  return <div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><aside className={styles.drawer}>
    <header><strong>任务中心</strong><Button iconOnly title="关闭" onClick={onClose}><X size={16}/></Button></header>
    <div className={styles.list}>{jobs.isLoading && <div className={styles.empty}>正在读取任务…</div>}{(jobs.data || []).map(job => <article key={job.id} className={styles.job}>
      <div className={styles.jobTop}><JobIcon status={job.status}/><div><strong>{job.kind}</strong><small>{new Date(job.created_at * 1000).toLocaleString()}</small></div><Badge tone={job.status === 'succeeded' ? 'good' : job.status === 'failed' ? 'bad' : job.status === 'running' ? 'warn' : 'neutral'}>{label(job.status)}</Badge></div>
      {job.error && <p className={styles.error}>{job.error}</p>}
      {Object.keys(job.checkpoint || {}).length > 0 && <code>{JSON.stringify(job.checkpoint)}</code>}
      <div className={styles.actions}>{['queued', 'running'].includes(job.status) && <Button size="small" tone="danger" onClick={() => action.mutate({ id: job.id, name: 'cancel' })}><CircleStop size={13}/>取消</Button>}{['failed', 'cancelled', 'interrupted'].includes(job.status) && <Button size="small" onClick={() => action.mutate({ id: job.id, name: 'retry' })}><RotateCcw size={13}/>重试</Button>}</div>
    </article>)}{!jobs.isLoading && !jobs.data?.length && <div className={styles.empty}>暂无任务</div>}</div>
  </aside></div>
}

function JobIcon({ status }: { status: JobRecord['status'] }) { return status === 'succeeded' ? <CheckCircle2 size={17}/> : status === 'failed' ? <XCircle size={17}/> : status === 'running' ? <RefreshCw className={styles.spin} size={17}/> : <Clock3 size={17}/> }
function label(status: JobRecord['status']) { return ({ queued: '排队', running: '运行中', succeeded: '完成', failed: '失败', cancelled: '取消', interrupted: '中断' } as const)[status] }
