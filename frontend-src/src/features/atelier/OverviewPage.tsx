import { useQuery } from '@tanstack/react-query'
import { ArrowDownToLine,ArrowRight,Download,Plus } from 'lucide-react'
import { useState } from 'react'
import { Link,useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { FolioGlyph } from '../../components/AtelierBrand'
import { BrandConstruction } from '../../components/BrandConstruction'
import { Button,Input } from '../../components/kit'
import { isComposingKey } from '../../hooks/useImeGuard'
import { activateProject } from '../studio/projects'
import { flushSave } from '../studio/store'
import type { Doc } from '../studio/types'
import styles from './atelier.module.css'
import { ProjectPreview } from './ProjectPreview'


import { errorText,jobNames,request,type Asset,type Job,type Toast } from './atelierApi'
import { ErrorNotice } from './ResourceFeedback'

export function OverviewPage({ toast }: { toast: Toast }) {
  const overview = useQuery({ queryKey: ['atelier-overview'], queryFn: () => api<{ projects: (Asset & {preview?:{name:string;doc:Doc;updated_at:string}})[]; series: any[]; jobs: Job[]; artworks: Asset[] }>('/api/v1/overview'), refetchInterval: 5000 })
  const status = useQuery({ queryKey: ['server-status'], queryFn: () => api<{ state: string; profile?: string }>('/api/v1/server/status') })
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const data = overview.data
  const newProject = async () => {
    try { await flushSave(); const project = await request<Asset>('/objects/project', { name: name || '未命名创作', data: {} }); await activateProject(project.id); setName(''); navigate('/studio') } catch (e) { toast(errorText(e)) }
  }
  return <div className={styles.home}>
    <header className={styles.intro}><div className={styles.introCopy}><h1>把念头，<br />写成画面。</h1><div className={styles.newProject}><label htmlFor="project-name">开始一个创作项目</label><div className={styles.inline}><Input id="project-name" placeholder="为项目起个名字…" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !isComposingKey(e.nativeEvent)) void newProject() }} /><Button tone="primary" onClick={() => void newProject()} title="新建创作项目"><Plus size={17} />创建</Button></div></div></div><BrandConstruction daily /></header>
    <ErrorNotice error={overview.error} />
    <div className={styles.homeColumns}><section><div className={styles.sectionTitle}><h2>接着创作</h2><Link to="/studio">打开创作台 <ArrowRight size={14} /></Link></div>
      <div className={styles.projectList}>{data?.projects.map(project => <button className={styles.project} key={project.id} onClick={async () => { try { await activateProject(project.id); navigate('/studio') } catch (e) { toast(errorText(e)) } }}><span className={styles.projectMark}><ProjectPreview doc={project.preview?.doc}/></span><span><strong>{project.name}</strong><small>{project.preview ? `${project.preview.doc.kind === "layout" ? "构图" : "文稿"} · ${project.preview.name}` : "文稿 · 构图 · 出图"}</small></span><ArrowRight size={18} /></button>)}</div>
      {overview.isLoading && <p>正在读取项目…</p>}
      <div className={styles.sectionTitle}><h2>最近的作品</h2><Link to="/assets">查看素材 <ArrowRight size={14} /></Link></div>
      {data?.artworks.length ? <div className={styles.gallery}>{data.artworks.map(art => <Link to="/assets" key={art.id}><img src={art.data.url} alt={art.name} /><span>{art.name}</span></Link>)}</div> : <div className={styles.blankWork}><FolioGlyph className={styles.blankFolio}/><div><h3>留给下一幅作品的位置</h3><p>保存的作品会陈列在这里。</p><Link to="/studio">开始写下画面 <ArrowRight size={14} /></Link></div></div>}
    </section><aside className={styles.homeAside}><div className={styles.sectionTitle}><h2>模型状态</h2></div><div className={styles.runtime}><span className={styles.statusDot} data-running={status.data?.state === 'running'} /><strong>{status.data?.state === 'running' ? '本地推理运行中' : '本地推理已停止'}</strong><p>{status.data?.profile || '从模型档案中选择适合这次创作的配置。'}</p><Link to="/models">管理模型 <ArrowRight size={14} /></Link></div>
      <div className={styles.sectionTitle}><h2>最近任务</h2><Download size={16} /></div>{data?.jobs.slice(0, 5).map(job => <div className={styles.smallJob} key={job.id}><strong>{job.title}</strong><span>{jobNames[job.status]}</span></div>)}{!data?.jobs.length && <p className={styles.muted}>暂无任务</p>}
      <Link className={styles.downloadLink} to="/downloads"><ArrowDownToLine size={20} /><span>获取新的模型<small>解析 Hugging Face 链接，选择需要的文件</small></span><ArrowRight size={16} /></Link>
    </aside></div>
  </div>
}
