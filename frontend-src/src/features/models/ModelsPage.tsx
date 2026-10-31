import { Copy, ExternalLink, PackageOpen, Pencil, Pin, Play, Plus, Search, Square, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { Badge, Button, ConfirmButton, Input, Panel, Select } from '../../components/ui'
import type { AppConfig } from '../../types'
import { estimateUsage } from '../../utils/vram'
import { ResourceUsage } from '../../components/ResourceUsage'
import page from '../pages.module.css'
import styles from './models.module.css'

type ProfileMeta = { name?: string; architecture?: string; layers?: number; active_experts?: number; context_length?: number; native_mtp?: boolean; hidden?: number; kv_layers?: number; kv_bytes_per_token?: number; kv_bytes_per_token_f16?: number; experts?: number; moe_layers?: number }

type Profile = {
  name: string
  is_current: boolean
  is_running: boolean
  engine?: string
  model_path: string
  model_name: string
  model_size_mb: number
  model_exists: boolean
  model_meta: ProfileMeta
  ctx_size: number
  ngl: number
  fit_enabled: boolean
  n_cpu_moe: number
  kv_cache_quant_k: string
  kv_cache_quant_v: string
  flash_attn: boolean
  mtp_enabled: boolean
  thinking?: boolean
  chat_template_file?: string
  host: string
  port: number
  kvmem?: { workspace: number; budget: number; gen_reserve: number; kv_dtype: string; enable_thinking?: boolean; sink_tokens?: number; recent_tokens?: number; lrfu?: boolean; score_agg?: string }
  ninfer?: { max_context: number; budget: number; gen_reserve: number; host_kv_mib: number; kv_dtype: string; spec: string; draft_tokens: number; sink_tokens?: number; recent_tokens?: number; lrfu?: boolean; score_agg?: string; prefill_chunk?: number; cuda_graph?: boolean }
}

// Retrieval is what separates the tiered engines from a plain context window,
// so every card states how it ranks and what it pins.
function retrievalBadge(lrfu?: boolean, scoreAgg?: string) {
  if (!lrfu && !scoreAgg) return { label: '检索 关' }
  return { label: `检索 ${lrfu ? 'LRFU' : '分数'}${scoreAgg === 'max' ? '·max' : ''}`, active: true }
}


function errorMessage(reason: unknown) { return reason instanceof Error ? reason.message : String(reason) }

export function ModelsPage({ config, dirty, server, toast }: {
  config: AppConfig
  dirty: boolean
  server: { state: string; pid?: number; profile?: string }
  toast: (text: string) => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const profilesQuery = useQuery({ queryKey: ['profiles'], queryFn: () => api<{ profiles: Profile[] }>('/api/v1/profiles') })
  const profiles = profilesQuery.data?.profiles || []
  const [search, setSearch] = useState('')
  const [engineFilter, setEngineFilter] = useState('all')
  const visibleProfiles = profiles.filter(profile => `${profile.name} ${profile.model_name}`.toLowerCase().includes(search.toLowerCase()) && (engineFilter === 'all' || (profile.engine || 'llama.cpp') === engineFilter)).sort((a, b) => Number(b.is_running || b.is_current) - Number(a.is_running || a.is_current))
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState('')
  const serverRunning = server.state === 'running'

  // Skip the first run: the mount fetch is already in flight, and
  // invalidateQueries cancels+restarts it by default (doubling a slow load).
  const firstInvalidate = useRef(true)
  useEffect(() => {
    if (firstInvalidate.current) { firstInvalidate.current = false; return }
    void queryClient.invalidateQueries({ queryKey: ['profiles'] }, { cancelRefetch: false })
  }, [queryClient, server.state, server.profile])

  const afterServerAction = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['profiles'] }),
      queryClient.invalidateQueries({ queryKey: ['server-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['config'] }),
      queryClient.invalidateQueries({ queryKey: ['current-profile'] }),
    ])
  }

  const launch = async (profile: Profile) => {
    setBusy(profile.name)
    try {
      const result = await api<{ restarted: boolean }>('/api/v1/profiles/launch', { method: 'POST', body: JSON.stringify({ name: profile.name }) })
      toast(result.restarted ? `已切换到档案：${profile.name}` : `已启动档案：${profile.name}`)
      await afterServerAction()
    } catch (reason) { toast(`启动失败：${errorMessage(reason)}`) } finally { setBusy('') }
  }

  const stop = async () => {
    setBusy('__stop__')
    try { await api('/api/v1/server/stop', { method: 'POST' }); toast('服务已停止'); await afterServerAction() } catch (reason) { toast(`停止失败：${errorMessage(reason)}`) } finally { setBusy('') }
  }

  const setCurrent = async (profile: Profile) => {
    setBusy(profile.name)
    try {
      await api('/api/v1/profiles/set-current', { method: 'POST', body: JSON.stringify({ name: profile.name }) })
      toast(`当前档案：${profile.name}`)
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['profiles'] }), queryClient.invalidateQueries({ queryKey: ['config'] }), queryClient.invalidateQueries({ queryKey: ['current-profile'] })])
    } catch (reason) { toast(`设置失败：${errorMessage(reason)}`) } finally { setBusy('') }
  }

  const edit = async (profile: Profile) => {
    // No local setConfig: server state changed, so invalidate and let the Shell
    // apply one atomic update — otherwise the dirty flag flashes falsely.
    await api<AppConfig>('/api/v1/config/load', { method: 'POST', body: JSON.stringify({ name: profile.name }) })
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['config'] }),
      queryClient.invalidateQueries({ queryKey: ['current-profile'] }),
    ])
    navigate('/config')
  }

  const duplicate = async (profile: Profile) => {
    const taken = new Set(profiles.map(item => item.name))
    let name = `${profile.name}-copy`
    for (let index = 2; taken.has(name); index += 1) name = `${profile.name}-copy${index}`
    setBusy(profile.name)
    try {
      await api('/api/v1/profiles/duplicate', { method: 'POST', body: JSON.stringify({ source: profile.name, name }) })
      toast(`已复制为：${name}`); await queryClient.invalidateQueries({ queryKey: ['profiles'] })
    } catch (reason) { toast(`复制失败：${errorMessage(reason)}`) } finally { setBusy('') }
  }

  const remove = async (profile: Profile) => {
    if (profile.name === 'default') return toast('默认档案不能删除')
    setBusy(profile.name)
    try {
      await api('/api/v1/config/delete', { method: 'POST', body: JSON.stringify({ name: profile.name }) })
      if (profile.is_current) await api<AppConfig>('/api/v1/config/load', { method: 'POST', body: JSON.stringify({ name: 'default' }) })
      toast('档案已删除')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['profiles'] }),
        queryClient.invalidateQueries({ queryKey: ['config'] }),
        queryClient.invalidateQueries({ queryKey: ['current-profile'] }),
      ])
    } catch (reason) { toast(`删除失败：${errorMessage(reason)}`) } finally { setBusy('') }
  }

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      await api('/api/v1/config/save-as', { method: 'POST', body: JSON.stringify({ name, config }) })
      toast(`已创建档案：${name}（来自当前配置）`); setNewName(''); setCreating(false); await queryClient.invalidateQueries({ queryKey: ['profiles'] })
    } catch (reason) { toast(`创建失败：${errorMessage(reason)}`) }
  }

  return <>
    <div className={styles.libraryToolbar}>
      <div className={styles.search}><Search size={17}/><Input aria-label="搜索档案" placeholder="搜索模型或档案…" value={search} onChange={event => setSearch(event.target.value)}/></div>
      <Select className={styles.filter} aria-label="筛选推理引擎" value={engineFilter} onChange={event => setEngineFilter(event.target.value)}><option value="all">全部引擎</option><option value="llama.cpp">llama.cpp</option><option value="kvmem">KVMem</option><option value="ninfer">NInfer</option></Select>
      <span className={styles.count}>{visibleProfiles.length} 个档案</span>
      {creating
        ? <div className={styles.createRow}><Input aria-label="新档案名称" placeholder="档案名称" value={newName} onChange={event => setNewName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && newName.trim()) void create() }} autoFocus /><Button tone="primary" disabled={!newName.trim()} onClick={() => void create()}>确定</Button><Button onClick={() => { setCreating(false); setNewName('') }}>取消</Button></div>
        : <Button tone="primary" onClick={() => setCreating(true)}><Plus size={15}/>新建档案</Button>}
    </div>
    {dirty && <p className={page.hint}>当前有未保存的配置修改，切换档案前请保存。</p>}
    {profilesQuery.isError && <Panel><p className={page.hint}>加载档案失败：{errorMessage(profilesQuery.error)}　<Button size="small" onClick={() => void profilesQuery.refetch()}>重试</Button></p></Panel>}
    {profilesQuery.isPending && !profilesQuery.isError && <div className={styles.grid}>{[0, 1, 2].map(i => <div key={i} className={styles.skeletonCard}><span/><span/><span/></div>)}</div>}
    {profilesQuery.isSuccess && profiles.length === 0 && <Panel><p className={page.hint}><PackageOpen size={14} style={{ verticalAlign: -2 }}/> 还没有档案。在「配置」页填写模型与参数后保存，或点击右上角「新建档案」。</p></Panel>}
    {profilesQuery.isSuccess && profiles.length > 0 && visibleProfiles.length === 0 && <div className={styles.noResults}>没有匹配的档案。<Button size="small" onClick={() => { setSearch(''); setEngineFilter('all') }}>清除筛选</Button></div>}
    {profilesQuery.isSuccess && profiles.length > 0 && <div className={styles.grid}>
      {visibleProfiles.map((profile, index) => <ProfileCard key={profile.name} profile={profile} index={index} delay={Math.min(index * 55, 330)} busy={busy === profile.name} stopping={busy === '__stop__'} serverRunning={serverRunning} dirty={dirty} onLaunch={() => void launch(profile)} onStop={() => void stop()} onEdit={() => void edit(profile).catch(reason => toast(`载入失败：${errorMessage(reason)}`))} onSetCurrent={() => void setCurrent(profile)} onDuplicate={() => void duplicate(profile)} onRemove={() => void remove(profile)} />)}
    </div>}
  </>
}

function ProfileCard({ profile, index, delay, busy, stopping, serverRunning, dirty, onLaunch, onStop, onEdit, onSetCurrent, onDuplicate, onRemove }: {
  profile: Profile
  index: number
  delay: number
  busy: boolean
  stopping: boolean
  serverRunning: boolean
  dirty: boolean
  onLaunch: () => void
  onStop: () => void
  onEdit: () => void
  onSetCurrent: () => void
  onDuplicate: () => void
  onRemove: () => void
}) {
  const meta = profile.model_meta || {}
  const isKvmem = profile.engine === 'kvmem'
  const isNinfer = profile.engine === 'ninfer'
  const fmtK = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n))
  const sizeLabel = profile.model_size_mb >= 1024 ? `${(profile.model_size_mb / 1024).toFixed(1)} GB` : profile.model_size_mb ? `${profile.model_size_mb.toFixed(0)} MB` : ''
  const usage = estimateUsage({
    engine: profile.engine || 'llama.cpp', modelSizeMb: profile.model_size_mb,
    ctxSize: profile.ctx_size, kvCacheQuant: profile.kv_cache_quant_k || profile.kv_cache_quant_v || 'q8_0',
    kvmem: { budget: profile.kvmem?.budget ?? 0, gen_reserve: profile.kvmem?.gen_reserve ?? 0, kv_dtype: profile.kvmem?.kv_dtype ?? 'q8_0' },
    ninfer: { budget: profile.ninfer?.budget ?? 0, gen_reserve: profile.ninfer?.gen_reserve ?? 0, prefill_chunk: profile.ninfer?.prefill_chunk ?? 256, cuda_graph: profile.ninfer?.cuda_graph ?? false, host_kv_mib: profile.ninfer?.host_kv_mib ?? 4096 },
    nCpuMoe: (profile.engine || 'llama.cpp') === 'llama.cpp' ? (profile.n_cpu_moe ?? 0) : 0,
    geom: {
      kv_bytes_per_token: typeof meta.kv_bytes_per_token === 'number' ? meta.kv_bytes_per_token : undefined,
      kv_bytes_per_token_f16: typeof meta.kv_bytes_per_token_f16 === 'number' ? meta.kv_bytes_per_token_f16 : undefined,
      hidden: typeof meta.hidden === 'number' ? meta.hidden : undefined,
      kv_layers: typeof meta.kv_layers === 'number' ? meta.kv_layers : undefined,
      experts: typeof meta.experts === 'number' ? meta.experts : undefined,
      moe_layers: typeof meta.moe_layers === 'number' ? meta.moe_layers : undefined,
    },
  })
  const chips: { label: string; active?: boolean }[] = [
    ...(isKvmem ? [{ label: 'KVMem', active: true }] : []),
    ...(isNinfer ? [{ label: 'NInfer', active: true }] : []),
    { label: `ctx ${isKvmem ? fmtK(profile.kvmem?.workspace ?? profile.ctx_size) : isNinfer ? fmtK(profile.ninfer?.max_context ?? 0) : fmtK(profile.ctx_size)}`, active: true },
    ...(isKvmem ? [{ label: `预算 ${fmtK(profile.kvmem?.budget ?? 0)}` }, { label: `预留 ${fmtK(profile.kvmem?.gen_reserve ?? 0)}` }, ...(profile.kvmem?.kv_dtype ? [{ label: `KV ${profile.kvmem.kv_dtype}` }] : []), retrievalBadge(profile.kvmem?.lrfu, profile.kvmem?.score_agg)] : []),
    ...(isNinfer && profile.ninfer ? [
      { label: `预算 ${fmtK(profile.ninfer.budget)}` },
      { label: `预留 ${fmtK(profile.ninfer.gen_reserve)}` },
      { label: `主机 ${Math.round(profile.ninfer.host_kv_mib / 1024)}G` },
      ...(profile.ninfer.kv_dtype ? [{ label: `KV ${profile.ninfer.kv_dtype}` }] : []),
      retrievalBadge(profile.ninfer.lrfu, profile.ninfer.score_agg),
      ...(profile.ninfer.spec !== 'none' ? [{ label: `${profile.ninfer.spec}×${profile.ninfer.draft_tokens}`, active: true }] : []),
    ] : []),
    ...(!isNinfer ? [profile.fit_enabled ? { label: 'GPU 自动适配' } : { label: `ngl ${profile.ngl}` }] : []),
    ...(profile.n_cpu_moe > 0 ? [{ label: `MoE→CPU ${profile.n_cpu_moe}` }] : []),
    ...(!isKvmem && (profile.kv_cache_quant_k || profile.kv_cache_quant_v) ? [{ label: `KV ${profile.kv_cache_quant_k || profile.kv_cache_quant_v}` }] : []),
    ...(profile.flash_attn ? [{ label: 'FlashAttn', active: true }] : []),
    ...(profile.mtp_enabled ? [{ label: 'MTP', active: true }] : []),
    ...(profile.thinking ? [{ label: '思考', active: true }] : []),
    ...(profile.chat_template_file ? [{ label: '自定义模板', active: true }] : []),
    { label: `${profile.host}:${profile.port}` },
    { label: `显存 ≈${usage.vram.totalGb.toFixed(1)}G · 内存 ≈${usage.ram.totalGb.toFixed(1)}G${usage.vram.over ? ' ⚠' : ''}` },
  ]
  const parts = [
    meta.name && meta.architecture ? `${meta.name} · ${meta.architecture}` : meta.architecture || '',
    meta.layers ? `${meta.layers} 层${meta.experts ? ` · MoE ${meta.experts}${meta.active_experts ? `/${meta.active_experts}` : ''}` : ''}` : '',
    meta.native_mtp ? '原生 MTP 头' : '',
    meta.context_length ? `原生 ${meta.context_length >= 1024 ? `${Math.round(meta.context_length / 1024)}K` : meta.context_length}` : '',
  ].filter(Boolean)
  const needsSwitch = serverRunning && !profile.is_running
  const fileMissing = !profile.model_exists && !!profile.model_path
  const featured = profile.is_current || profile.is_running
  const context = isKvmem ? profile.kvmem?.workspace ?? profile.ctx_size : isNinfer ? profile.ninfer?.max_context ?? profile.ctx_size : profile.ctx_size
  const engineLabel = isNinfer ? 'NInfer' : isKvmem ? 'KVMem' : 'llama.cpp'
  return <article aria-label={`档案 ${profile.name}`} className={`${styles.card} ${featured ? styles.featured : ''}`} data-running={profile.is_running} style={{ animationDelay: `${delay}ms` }}>
    <span className={styles.no} aria-hidden="true">No.{String(index + 1).padStart(2, '0')}</span>
    <header className={styles.cardHeader}>
      <div className={styles.titleRow}><h2 className={styles.titleName} title={profile.name}>{profile.name}</h2>{profile.is_running && <Badge tone="good">运行中</Badge>}{profile.is_current && <Badge>当前</Badge>}</div>
      <div className={styles.cardTools}>
        <ConfirmButton size="small" iconOnly confirm={dirty} confirmLabel="丢弃?" title="编辑参数" onConfirm={onEdit}><Pencil size={14}/></ConfirmButton>
        <Button size="small" iconOnly title="复制档案" disabled={busy} onClick={onDuplicate}><Copy size={14}/></Button>
        {!profile.is_current && <ConfirmButton size="small" iconOnly confirm={dirty} confirmLabel="丢弃?" title="设为当前档案（不启动）" onConfirm={onSetCurrent}><Pin size={14}/></ConfirmButton>}
        <ConfirmButton size="small" iconOnly tone="danger" disabled={profile.is_running || profile.name === 'default'} confirmLabel="确认?" title="删除档案" onConfirm={onRemove}><Trash2 size={14}/></ConfirmButton>
      </div>
    </header>
    <div className={styles.cardBody}>
      <div className={styles.identity}>
        <p className={styles.metaLine} title={profile.model_path}>{profile.model_name || '未选择模型文件'}</p>
        <div className={styles.facts}><span><b>{engineLabel}</b>推理引擎</span><span><b>{fmtK(context)}</b>上下文</span><span><b>{sizeLabel || '—'}</b>模型文件</span></div>
        {fileMissing && <p className={styles.missing}>文件缺失</p>}
        {parts.length > 0 && <p className={styles.geometry}>{parts.join(' · ')}</p>}
      </div>
      {profile.model_exists && profile.model_size_mb > 0 ? <ResourceUsage usage={usage} compact/> : <p className={styles.resourceUnknown}>选择有效模型后可查看资源估算</p>}
    </div>
    <footer className={styles.actions}>
      <details className={styles.details}><summary>参数详情</summary><div className={styles.chips}>{chips.map(chip => <span key={chip.label} className={styles.chip}>{chip.label}</span>)}</div></details>
      <div className={styles.launch}>
        {profile.is_running
          ? <><Button tone="danger" size="small" disabled={stopping} onClick={onStop}><Square size={14}/>{stopping ? '停止中…' : '停止'}</Button><Button size="small" onClick={() => window.open(profile.engine === 'ninfer' ? `/static/engine-webui.html?base=${encodeURIComponent(`http://${profile.host === '0.0.0.0' ? location.hostname : profile.host}:${profile.port}`)}` : `http://${profile.host === '0.0.0.0' ? location.hostname : profile.host}:${profile.port}/`, '_blank')}><ExternalLink size={14}/>WebUI</Button></>
          : <ConfirmButton tone="primary" size="small" confirm={needsSwitch || dirty} confirmLabel={dirty ? '未保存修改将丢弃，再点确认' : '会停止当前服务，再点确认'} disabled={busy || fileMissing} title={fileMissing ? '模型文件不存在' : undefined} onConfirm={onLaunch}>{busy ? <><Play size={14}/>启动中…</> : needsSwitch ? <><Play size={14}/>切换到此档案</> : <><Play size={14}/>启动</>}</ConfirmButton>}
      </div>
    </footer>
  </article>
}
