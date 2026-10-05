import { Copy, ExternalLink, PackageOpen, Pencil, Pin, Play, Plus, Square, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { Badge, Button, ConfirmButton, Input, Panel } from '../../components/ui'
import type { AppConfig } from '../../types'
import { estimateVram } from '../../utils/vram'
import page from '../pages.module.css'
import styles from './models.module.css'

type ProfileMeta = { name?: string; architecture?: string; layers?: number; experts?: number; active_experts?: number; context_length?: number; native_mtp?: boolean }

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
  kvmem?: { workspace: number; budget: number; gen_reserve: number; kv_dtype: string; enable_thinking?: boolean }
  ninfer?: { max_context: number; kv_capacity: number; host_kv_mib: number; kv_dtype: string; spec: string; draft_tokens: number; kv_window: number }
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
  const profilesQuery = useQuery({ queryKey: ['profiles'], queryFn: () => api<{ profiles: Profile[] }>('/api/profiles') })
  const profiles = profilesQuery.data?.profiles || []
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState('')
  const serverRunning = server.state === 'running'

  useEffect(() => { void queryClient.invalidateQueries({ queryKey: ['profiles'] }) }, [queryClient, server.state, server.profile])

  const afterServerAction = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['profiles'] }),
      queryClient.invalidateQueries({ queryKey: ['server-status'] }),
      queryClient.invalidateQueries({ queryKey: ['config'] }),
      queryClient.invalidateQueries({ queryKey: ['current-profile'] }),
    ])
  }

  const launch = async (profile: Profile) => {
    setBusy(profile.name)
    try {
      const result = await api<{ restarted: boolean }>('/api/profiles/launch', { method: 'POST', body: JSON.stringify({ name: profile.name }) })
      toast(result.restarted ? `已切换到档案：${profile.name}` : `已启动档案：${profile.name}`)
      await afterServerAction()
    } catch (reason) { toast(`启动失败：${errorMessage(reason)}`) } finally { setBusy('') }
  }

  const stop = async () => {
    setBusy('__stop__')
    try { await api('/api/server/stop', { method: 'POST' }); toast('服务已停止'); await afterServerAction() } catch (reason) { toast(`停止失败：${errorMessage(reason)}`) } finally { setBusy('') }
  }

  const setCurrent = async (profile: Profile) => {
    setBusy(profile.name)
    try {
      await api('/api/profiles/set-current', { method: 'POST', body: JSON.stringify({ name: profile.name }) })
      toast(`当前档案：${profile.name}`)
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['profiles'] }), queryClient.invalidateQueries({ queryKey: ['config'] }), queryClient.invalidateQueries({ queryKey: ['current-profile'] })])
    } catch (reason) { toast(`设置失败：${errorMessage(reason)}`) } finally { setBusy('') }
  }

  const edit = async (profile: Profile) => {
    // No local setConfig: server state changed, so invalidate and let the Shell
    // apply one atomic update — otherwise the dirty flag flashes falsely.
    await api<AppConfig>('/api/config/load', { method: 'POST', body: JSON.stringify({ name: profile.name }) })
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
      await api('/api/profiles/duplicate', { method: 'POST', body: JSON.stringify({ source: profile.name, name }) })
      toast(`已复制为：${name}`); await queryClient.invalidateQueries({ queryKey: ['profiles'] })
    } catch (reason) { toast(`复制失败：${errorMessage(reason)}`) } finally { setBusy('') }
  }

  const remove = async (profile: Profile) => {
    if (profile.name === 'default') return toast('默认档案不能删除')
    setBusy(profile.name)
    try {
      await api('/api/config/delete', { method: 'POST', body: JSON.stringify({ name: profile.name }) })
      if (profile.is_current) await api<AppConfig>('/api/config/load', { method: 'POST', body: JSON.stringify({ name: 'default' }) })
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
      await api('/api/config/save-as', { method: 'POST', body: JSON.stringify({ name, config }) })
      toast(`已创建档案：${name}（来自当前配置）`); setNewName(''); setCreating(false); await queryClient.invalidateQueries({ queryKey: ['profiles'] })
    } catch (reason) { toast(`创建失败：${errorMessage(reason)}`) }
  }

  return <>
    <div className={page.row} style={{ justifyContent: 'space-between', marginBottom: 12 }}>
      <p className={page.hint}>模型档案 = 模型文件 + 启动参数 + 采样 + 提示词{dirty ? ' · 当前有未保存的配置修改' : ''}</p>
      {creating
        ? <div className={styles.createRow}><Input placeholder="档案名称" value={newName} onChange={event => setNewName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && newName.trim()) void create() }} autoFocus /><Button tone="primary" disabled={!newName.trim()} onClick={() => void create()}>确定</Button><Button onClick={() => { setCreating(false); setNewName('') }}>取消</Button></div>
        : <Button tone="primary" onClick={() => setCreating(true)}><Plus size={15}/>新建档案</Button>}
    </div>
    {profilesQuery.isError && <Panel><p className={page.hint}>加载档案失败：{errorMessage(profilesQuery.error)}　<Button size="small" onClick={() => void profilesQuery.refetch()}>重试</Button></p></Panel>}
    {profilesQuery.isPending && !profilesQuery.isError && <div className={styles.grid}>{[0, 1, 2].map(i => <div key={i} className={styles.skeletonCard}><span/><span/><span/></div>)}</div>}
    {profilesQuery.isSuccess && profiles.length === 0 && <Panel><p className={page.hint}><PackageOpen size={14} style={{ verticalAlign: -2 }}/> 还没有档案。在「配置」页填写模型与参数后保存，或点击右上角「新建档案」。</p></Panel>}
    {profilesQuery.isSuccess && profiles.length > 0 && <div className={styles.grid}>
      {profiles.map(profile => <ProfileCard key={profile.name} profile={profile} busy={busy === profile.name} stopping={busy === '__stop__'} serverRunning={serverRunning} dirty={dirty} onLaunch={() => void launch(profile)} onStop={() => void stop()} onEdit={() => void edit(profile)} onSetCurrent={() => void setCurrent(profile)} onDuplicate={() => void duplicate(profile)} onRemove={() => void remove(profile)} />)}
    </div>}
  </>
}

function ProfileCard({ profile, busy, stopping, serverRunning, dirty, onLaunch, onStop, onEdit, onSetCurrent, onDuplicate, onRemove }: {
  profile: Profile
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
  const vram = estimateVram({
    engine: profile.engine || 'llama.cpp', modelSizeMb: profile.model_size_mb,
    ctxSize: profile.ctx_size, kvCacheQuant: profile.kv_cache_quant_k || profile.kv_cache_quant_v || 'q8_0',
    flashAttn: profile.flash_attn,
    kvmem: { budget: profile.kvmem?.budget ?? 0, gen_reserve: profile.kvmem?.gen_reserve ?? 0, kv_dtype: profile.kvmem?.kv_dtype ?? 'q8_0' },
    ninfer: { kv_capacity: profile.ninfer?.kv_capacity ?? 0, prefill_chunk: 256, cuda_graph: false },
  })
  const chips: { label: string; active?: boolean }[] = [
    ...(isKvmem ? [{ label: 'KVMem', active: true }] : []),
    ...(isNinfer ? [{ label: 'NInfer', active: true }] : []),
    { label: `ctx ${isKvmem ? fmtK(profile.kvmem?.workspace ?? profile.ctx_size) : isNinfer ? fmtK(profile.ninfer?.max_context ?? 0) : fmtK(profile.ctx_size)}`, active: true },
    ...(isKvmem ? [{ label: `预算 ${fmtK(profile.kvmem?.budget ?? 0)}` }, { label: `预留 ${fmtK(profile.kvmem?.gen_reserve ?? 0)}` }, ...(profile.kvmem?.kv_dtype ? [{ label: `KV ${profile.kvmem.kv_dtype}` }] : [])] : []),
    ...(isNinfer && profile.ninfer ? [
      { label: `池 ${fmtK(profile.ninfer.kv_capacity)}` },
      { label: `主机 ${Math.round(profile.ninfer.host_kv_mib / 1024)}G` },
      ...(profile.ninfer.kv_dtype ? [{ label: `KV ${profile.ninfer.kv_dtype}` }] : []),
      ...(profile.ninfer.kv_window > 0 ? [{ label: '检索', active: true }] : []),
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
    { label: `显存 ≈${vram.totalGb.toFixed(1)}G${vram.over ? ' ⚠' : ''}` },
  ]
  const parts = [
    meta.name && meta.architecture ? `${meta.name} · ${meta.architecture}` : meta.architecture || '',
    meta.layers ? `${meta.layers} 层${meta.experts ? ` · MoE ${meta.experts}${meta.active_experts ? `/${meta.active_experts}` : ''}` : ''}` : '',
    meta.native_mtp ? '原生 MTP 头' : '',
    meta.context_length ? `原生 ${meta.context_length >= 1024 ? `${Math.round(meta.context_length / 1024)}K` : meta.context_length}` : '',
  ].filter(Boolean)
  const needsSwitch = serverRunning && !profile.is_running
  const fileMissing = !profile.model_exists && !!profile.model_path
  return (
    <Panel className={profile.is_running ? styles.cardRunning : ''} title={<span className={styles.titleRow}><span className={styles.titleName}>{profile.name}</span>{profile.is_running && <Badge tone="good">运行中</Badge>}{profile.is_current && !profile.is_running && <Badge>当前</Badge>}</span>} actions={
      <div className={page.row}>
        <ConfirmButton size="small" iconOnly confirm={dirty} confirmLabel="丢弃?" title="编辑参数" onConfirm={onEdit}><Pencil size={14}/></ConfirmButton>
        <Button size="small" iconOnly title="复制档案" disabled={busy} onClick={onDuplicate}><Copy size={14}/></Button>
        {!profile.is_current && <ConfirmButton size="small" iconOnly confirm={dirty} confirmLabel="丢弃?" title="设为当前档案（不启动）" onConfirm={onSetCurrent}><Pin size={14}/></ConfirmButton>}
        <ConfirmButton size="small" iconOnly tone="danger" disabled={profile.is_running || profile.name === 'default'} confirmLabel="确认?" title="删除档案" onConfirm={onRemove}><Trash2 size={14}/></ConfirmButton>
      </div>
    }>
      <p className={styles.metaLine} title={profile.model_path}>
        {profile.model_name ? <>{profile.model_name}{sizeLabel && ` · ${sizeLabel}`}</> : '未选择模型文件'}
      </p>
      {parts.length > 0 && <p className={styles.metaLine}>{parts.join(' · ')}</p>}
      <div className={styles.chips}>
        {fileMissing && <span className={`${styles.chip} ${styles.chipMissing}`}>文件缺失</span>}
        {chips.map(chip => <span key={chip.label} className={`${styles.chip} ${chip.active ? styles.chipActive : ''}`}>{chip.label}</span>)}
      </div>
      <div className={styles.actions}>
        {profile.is_running
          ? <div className={page.row}><Button tone="danger" size="small" disabled={stopping} onClick={onStop}><Square size={14}/>{stopping ? '停止中…' : '停止'}</Button><Button size="small" onClick={() => window.open(profile.engine === 'ninfer' ? `/static/engine-webui.html?base=${encodeURIComponent(`http://${profile.host === '0.0.0.0' ? location.hostname : profile.host}:${profile.port}`)}` : `http://${profile.host === '0.0.0.0' ? location.hostname : profile.host}:${profile.port}/`, '_blank')}><ExternalLink size={14}/>WebUI</Button></div>
          : <ConfirmButton tone="primary" size="small" confirm={needsSwitch || dirty} confirmLabel={dirty ? '未保存修改将丢弃，再点确认' : '会停止当前服务，再点确认'} disabled={busy || fileMissing} title={fileMissing ? '模型文件不存在' : undefined} onConfirm={onLaunch}>{busy ? <><Play size={14}/>启动中…</> : needsSwitch ? <><Play size={14}/>切换到此档案</> : <><Play size={14}/>启动</>}</ConfirmButton>}
      </div>
    </Panel>
  )
}
