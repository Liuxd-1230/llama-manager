import { AtelierGlyph } from '../../components/AtelierBrand'
import { useQuery,useQueryClient } from '@tanstack/react-query'
import { Copy,Pause,Play,X } from 'lucide-react'
import { useEffect } from 'react'
import { api } from '../../api'
import { Badge,Button,Modal } from '../../components/kit'
import styles from './atelier.module.css'


import { bytes,errorText,jobNames,request,type Job,type Toast } from './atelierApi'
import { ErrorNotice } from './ResourceFeedback'
import { downloadMetrics, duration } from './downloadMetrics'

function TransferSummary({ job }: { job: Job }) {
  const progress = downloadMetrics(job.result.files || [], job.status === 'running')
  const files=job.result.files || []
  const phase=job.status!=='running' ? jobNames[job.status] : files.some((file:any)=>file.phase==='receiving') ? '接收中' : files.some((file:any)=>file.phase==='verifying') ? '校验中' : '正在连接'
  return <div className={styles.transferSummary} aria-label="下载总进度"><span>已下载 <b>{bytes(progress.done)}</b> / {progress.total==null?'大小未知':bytes(progress.total)}</span><span>{progress.percent == null ? '总大小待确认' : `${progress.percent.toFixed(1)}%`}</span><span aria-label="当前下载速度">{bytes(progress.speed)}/s</span><span role="status">{phase}{job.status==='running' && phase==='接收中' && progress.speed===0?' · 等待数据':''}</span><span>{progress.eta != null ? `预计剩余 ${duration(progress.eta)}` : '剩余时间待估算'}</span><progress aria-label="批次下载进度" max={progress.total || undefined} value={progress.total != null && progress.total > 0 ? progress.done : undefined}/></div>
}

export function JobList({ jobs, toast }: { jobs: Job[]; toast: Toast }) {
  const client = useQueryClient()
  const action = async (job: Job, operation: string) => { try { await request(job.kind === 'download' ? `/downloads/${job.id}/${operation}` : job.kind === 'generation' ? `/generations/${job.id}/cancel` : `/jobs/${job.id}/cancel`); void client.invalidateQueries({ queryKey: ['atelier-jobs'] }) } catch (e) { toast(errorText(e)) } }
  const activeIds=jobs.filter(job=>['running','queued'].includes(job.status)).map(job=>job.id).join(',')
  useEffect(()=>{
    if(!activeIds || typeof EventSource==='undefined')return
    let timer=0
    const sources=activeIds.split(',').map(id=>{const source=new EventSource(`/api/v1/jobs/${id}/events`);source.onmessage=event=>{const data=JSON.parse(event.data);if(['succeeded','failed','cancelled','interrupted'].includes(data.status))source.close();if(!timer)timer=window.setTimeout(()=>{timer=0;void client.invalidateQueries({queryKey:['atelier-jobs']})},300)};return source})
    return()=>{window.clearTimeout(timer);sources.forEach(source=>source.close())}
  },[activeIds,client])
  return <div className={styles.jobList}>{jobs.map(job => <article key={job.id} className={styles.job}><div className={styles.jobHeader}><AtelierGlyph className={styles.taskMark} state={job.status==='running'?'working':job.status==='succeeded'?'complete':job.status==='failed'?'error':'idle'}/><strong>{job.title}</strong><Badge tone={job.status === 'succeeded' ? 'good' : job.status === 'failed' ? 'warn' : 'neutral'}>{jobNames[job.status] || job.status}</Badge><span className={styles.spacer} />{job.kind === 'download' && <><Button disabled={!['running', 'queued'].includes(job.status)} onClick={() => void action(job, 'pause')} title="暂停下载"><Pause size={14} /></Button><Button disabled={!['paused', 'failed', 'interrupted'].includes(job.status)} onClick={() => void action(job, 'resume')} title="恢复下载"><Play size={14} /></Button></>}{['queued', 'running', 'paused'].includes(job.status) && ['download', 'generation', 'agent'].includes(job.kind) && <Button onClick={() => void action(job, 'cancel')} title="取消任务"><X size={14} /></Button>}</div>{job.kind === 'download' && <TransferSummary job={job}/>} {job.result.phase && <p className={styles.taskPhase} role="status">{{queued:"等待",parsing:"解析",building:"构建",validating:"验证",saving:"保存",completed:"完成",generating:"等待 ComfyUI 输出",failed:"失败",cancelled:"取消"}[String(job.result.phase)] || job.result.phase}</p>}{job.error && <p role="alert" className={styles.error}>{job.error}</p>}{(job.result.files || []).map((file: any) => <div className={styles.fileProgress} key={file.task_id}><span>{file.filename}</span><span>{file.state} · {bytes(file.bytes_done)} / {bytes(file.size)}</span>{file.speed > 0 && <span>{bytes(file.speed)}/s</span>}<progress aria-label={`${file.filename} 下载进度`} max={file.size || undefined} value={file.size ? file.bytes_done || 0 : undefined} />{file.note && <small className={styles.muted}>{file.note}</small>}{file.range_supported===false && file.resumed_from>0 && <small>下载源未接受续传，本次从头接收。</small>}{file.error && <small>{file.error}</small>}{file.local_path && <div className={styles.inline}><code>{file.local_path}</code><Button title="复制文件路径" onClick={() => { void navigator.clipboard.writeText(file.local_path); toast('路径已复制') }}><Copy size={13} /></Button>{/\.(gguf|ninfer)$/i.test(file.local_path) && <Button onClick={async () => { try { await request('/models/register', { name: file.filename.replace(/\.[^.]+$/, '').split('/').pop(), data: { path: file.local_path } }); toast('已创建模型档案，尚未启动') } catch (e) { toast(errorText(e)) } }}>创建档案</Button>}</div>}</div>)}</article>)}{!jobs.length && <p className={styles.muted}>暂无任务</p>}</div>
}

export function TasksDrawer({ open, onClose, toast }: { open: boolean; onClose: () => void; toast: Toast }) {
  const jobs = useQuery({ queryKey: ['atelier-jobs'], queryFn: () => api<Job[]>('/api/v1/jobs'), refetchInterval: open ? 1500 : 10000 })
  return open ? <Modal title="任务" onClose={onClose} wide><ErrorNotice error={jobs.error} /><JobList jobs={jobs.data || []} toast={toast} /></Modal> : null
}
