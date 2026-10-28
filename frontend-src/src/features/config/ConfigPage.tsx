import { ClipboardPaste, Copy, Download, FolderOpen, RefreshCw, Save, Trash2, Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ConfirmDialog, Modal } from '../../components/Modal'
import { ResourceUsage } from '../../components/ResourceUsage'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import { FileBrowser } from '../../components/FileBrowser'
import { Badge, Button, Field, Input, Panel, Select, Switch, Textarea } from '../../components/ui'
import type { AppConfig } from '../../types'
import { applyLaunchCommand } from './commandImport'
import { estimateFromConfig } from '../../utils/vram'
import page from '../pages.module.css'

type BrowseTarget = { key: 'llama_cpp_dir' | 'model_path' | 'mmproj_path' | 'chat_template_file'; mode: 'folder' | 'file'; extension?: string } | null

export function ConfigPage({ config, setConfig, dirty, toast }: { config: AppConfig; setConfig: (config: AppConfig) => void; dirty: boolean; toast: (text: string) => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('default')
  const nameTouched = useRef(false)
  const [operation, setOperation] = useState('')
  const [operationError, setOperationError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const attempt = async (label: string, action: () => Promise<unknown>) => { setOperation(label); setOperationError(''); try { await action() } catch (reason) { setOperationError(`${label}失败：${reason instanceof Error ? reason.message : String(reason)}。修改已保留，请重试。`) } finally { setOperation('') } }
  const [pendingLoad, setPendingLoad] = useState('')
  const requestLoad = (selected: string) => {
    if (!selected) return
    if (dirty) { setPendingLoad(selected); return }
    void attempt('载入', () => load(selected))
  }
  const currentNameQuery = useQuery({ queryKey: ['current-profile'], queryFn: () => api<{ name: string }>('/api/v1/profiles/current'), staleTime: 0 })
  // Direct read of the model file the current config points at — no second
  // query to correlate, so the estimator's weight term is always live.
  const modelInfoQuery = useQuery({
    queryKey: ['model-info', config.model_path, config.engine],
    queryFn: () => api<{ size_mb: number; meta: Record<string, unknown> }>(`/api/v1/model-info?path=${encodeURIComponent(config.model_path)}`),
    enabled: !!config.model_path.trim(),
    staleTime: 60000,
  })
  const usage = estimateFromConfig(config, modelInfoQuery.data?.size_mb || 0, modelInfoQuery.data?.meta)
  useEffect(() => { if (!nameTouched.current && currentNameQuery.data?.name) setName(currentNameQuery.data.name) }, [currentNameQuery.data])
  const [configs, setConfigs] = useState<string[]>([])
  const [browse, setBrowse] = useState<BrowseTarget>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const importRef = useRef<HTMLInputElement>(null)
  const basic = config.basic
  const sampling = config.sampling
  const mtp = config.mtp
  const kvmem = config.kvmem

  const patch = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => setConfig({ ...config, [key]: value })
  const patchBasic = (value: Partial<AppConfig['basic']>) => patch('basic', { ...basic, ...value })
  const patchSampling = (value: Partial<AppConfig['sampling']>) => patch('sampling', { ...sampling, ...value })
  const patchMtp = (value: Partial<AppConfig['mtp']>) => patch('mtp', { ...mtp, ...value })
  const patchKvmem = (value: Partial<AppConfig['kvmem']>) => patch('kvmem', { ...kvmem, ...value })
  const ninfer = config.ninfer
  const patchNinfer = (value: Partial<AppConfig['ninfer']>) => patch('ninfer', { ...ninfer, ...value })
  const isKvmem = config.engine === 'kvmem'
  const isNative = config.engine === 'llama.cpp'
  const isNinfer = config.engine === 'ninfer'
  // Engine switches carry the context number across (ctx ↔ workspace) and keep
  // the kvmem trio valid: budget+reserve must stay ≤ workspace, snapped to 128.
  const switchEngine = (engine: AppConfig['engine']) => {
    if (engine === config.engine) return
    if (engine === 'kvmem') {
      const workspace = Math.max(1024, basic.ctx_size || kvmem.workspace)
      let { budget, gen_reserve } = kvmem
      if (budget + gen_reserve > workspace) {
        const scale = workspace / (budget + gen_reserve)
        budget = Math.max(128, Math.floor((budget * scale) / 128) * 128)
        gen_reserve = Math.max(128, Math.floor((gen_reserve * scale) / 128) * 128)
        if (budget + gen_reserve > workspace) gen_reserve = Math.max(128, workspace - budget)
      }
      setConfig({ ...config, engine, kvmem: { ...kvmem, workspace, budget, gen_reserve } })
    } else {
      setConfig({ ...config, engine, basic: { ...basic, ctx_size: kvmem.workspace } })
    }
  }
  const detectQuery = useQuery({
    queryKey: ['detect-binary', config.engine, config.llama_cpp_dir],
    queryFn: () => api<{ found: boolean; path: string; dir: string; bundled: boolean; lrfu: boolean }>(`/api/v1/detect-server?llama_cpp_dir=${encodeURIComponent(config.llama_cpp_dir)}&engine=${config.engine}`),
    staleTime: 30000,
  })
  // LRFU and --kvmem-score-agg only exist on v0.17+ workers; the preview and
  // the form both follow whatever the detected binary actually advertises.
  const engineSupportsLrfu = !!detectQuery.data?.lrfu

  const refreshNames = async () => {
    try { setConfigs((await api<{ configs: string[] }>('/api/v1/config/list')).configs || []) } catch { setConfigs([]) }
  }
  useEffect(() => { void refreshNames() }, [])

  const save = async () => {
    await api('/api/v1/config/save-as', { method: 'POST', body: JSON.stringify({ name: name || 'default', config }) })
    toast(`配置已保存：${name || 'default'}`); await refreshNames()
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['config'] }), queryClient.invalidateQueries({ queryKey: ['current-profile'] }), queryClient.invalidateQueries({ queryKey: ['profiles'] })])
  }
  const load = async (selected: string) => {
    if (!selected) return
    await api<AppConfig>('/api/v1/config/load', { method: 'POST', body: JSON.stringify({ name: selected }) })
    setName(selected); nameTouched.current = true; toast(`已载入：${selected}`)
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['config'] }), queryClient.invalidateQueries({ queryKey: ['current-profile'] })])
  }
  const remove = async () => {
    if (!name || name === 'default') return toast('默认配置不能删除')
    await api('/api/v1/config/delete', { method: 'POST', body: JSON.stringify({ name }) })
    nameTouched.current = false; await load('default'); toast('配置已删除'); await refreshNames(); await queryClient.invalidateQueries({ queryKey: ['profiles'] })
  }
  const exportConfig = () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${name || 'config'}.json`; link.click(); URL.revokeObjectURL(link.href)
  }
  const importConfig = async (file?: File) => {
    if (!file) return
    const imported = await api<AppConfig>('/api/v1/config/import', { method: 'POST', body: JSON.stringify({ content: await file.text() }) })
    setConfig(imported); toast('配置已导入，保存后生效')
  }

  const importCommand = () => {
    const result = applyLaunchCommand(config, importText)
    setConfig(result.config)
    setImportOpen(false); setImportText('')
    const extras = result.unknown.length ? `；未识别的已放入附加参数：${result.unknown.join(' ')}` : ''
    const warned = result.warnings.length ? `；${result.warnings.join('；')}` : ''
    toast(`已解析 ${result.applied} 项参数${extras}${warned}`)
  }
  const pasteFromClipboard = async () => {
    try { setImportText(await navigator.clipboard.readText()) } catch { toast('无法读取剪贴板，请手动粘贴') }
  }

  const command = useMemo(() => {
    if (config.engine === 'ninfer') {
      // Mirrors _build_ninfer_command, including the page-aligned values the
      // engine actually receives.
      const n = ninfer
      const budget = alignTo(n.budget, KV_PAGE), reserve = alignTo(n.gen_reserve, KV_PAGE)
      const sink = alignTo(n.sink_tokens, KV_PAGE), recent = n.recent_tokens > 0 ? Math.max(KV_PAGE, alignTo(n.recent_tokens, KV_PAGE)) : 0
      const args: string[] = ['ninfer-kvmem-server', quote(config.model_path || '<model.ninfer>')]
      args.push('--host', config.server.host, '--port', String(config.server.port))
      args.push('--max-context', String(n.max_context))
      args.push('--kvmem-budget', String(budget), '--kvmem-gen-reserve', String(reserve), '--kvmem-host-mib', String(n.host_kv_mib), '--kvmem-sessions', String(Math.min(16, Math.max(1, n.sessions))))
      if (sink > 0) args.push('--kvmem-sink-tokens', String(sink))
      if (recent > 0) args.push('--kvmem-recent-tokens', String(recent))
      if (n.lrfu) args.push('--kvmem-lrfu', '--kvmem-lrfu-lambda', String(n.lrfu_lambda), '--kvmem-lrfu-top-frac', String(n.lrfu_top_frac))
      if (engineSupportsLrfu) args.push('--kvmem-score-agg', n.score_agg)
      args.push('--kv-dtype', n.kv_dtype)
      if (n.prefill_chunk > 0) args.push('--prefill-chunk', String(Math.max(128, Math.floor(n.prefill_chunk / 128) * 128)))
      args.push('--max-concurrency', String(Math.min(8, Math.max(1, n.max_concurrency))))
      if (n.default_max_tokens > 0) args.push('--default-max-tokens', String(n.default_max_tokens))
      if (!n.cuda_graph) args.push('--no-cuda-graph')
      if (n.fast_prefill) args.push('--fast-prefill-kernel')
      if (n.disk_path.trim()) args.push('--kvmem-disk-path', quote(n.disk_path.trim()), '--kvmem-disk-mib', String(n.disk_mib))
      args.push('--cors')
      if (n.spec !== 'none') {
        args.push('--spec', n.spec, '--draft-tokens', String(Math.min(15, Math.max(1, n.draft_tokens))))
        if (n.adaptive_mtp) args.push('--adaptive-mtp')
        if (n.ngram_draft_tokens > 0) args.push('--ngram-draft-tokens', String(Math.min(63, Math.max(1, n.ngram_draft_tokens))), '--ngram-min-match', String(Math.min(64, Math.max(4, n.ngram_min_match))))
      }
      args.push('--temperature', String(sampling.temperature), '--top-p', String(sampling.top_p), '--top-k', String(Math.max(0, Math.min(sampling.top_k, 20))))
      if (sampling.min_p_enabled) args.push('--min-p', String(sampling.min_p))
      if (sampling.presence_penalty_enabled) args.push('--presence-penalty', String(sampling.presence_penalty))
      args.push('--default-reasoning-effort', basic.enable_thinking ? n.reasoning_effort : 'none')
      if (n.default_thinking_budget > 0) args.push('--default-thinking-budget', String(n.default_thinking_budget))
      if (n.model_id.trim()) args.push('--model-id', n.model_id.trim())
      if (config.extra_params.trim()) args.push(config.extra_params.trim())
      return args.join(' ')
    }
    if (config.engine === 'kvmem') {
      const k = kvmem
      const sink = alignTo(k.sink_tokens, k.block_tokens), recent = alignTo(k.recent_tokens, k.block_tokens)
      const args: string[] = ['llama-kvmem-server', '-m', quote(config.model_path || '<model.gguf>')]
      if (config.mmproj_path) { args.push('--mmproj', quote(config.mmproj_path)); args.push(config.mmproj_gpu ? '--mmproj-offload' : '--no-mmproj-offload') }
      if (basic.ngl_enabled) args.push('-ngl', String(basic.ngl))
      args.push('--host', config.server.host, '--port', String(config.server.port))
      args.push('-c', String(k.workspace), '-b', String(k.batch), '--ubatch-size', String(k.ubatch), '-n', String(k.gen_reserve))
      args.push('--kvmem-budget', String(k.budget), '--kvmem-gen-reserve', String(k.gen_reserve), '--kvmem-block-tokens', String(k.block_tokens), '--kvmem-query-policy', k.query_policy, '--kvmem-query-replay', 'auto', '--kv-dtype', k.kv_dtype)
      if (sink > 0) args.push('--kvmem-sink-tokens', String(sink))
      if (recent > 0) args.push('--kvmem-recent-tokens', String(recent))
      if (k.lrfu) args.push('--kvmem-lrfu', '--kvmem-lrfu-lambda', String(k.lrfu_lambda), '--kvmem-lrfu-top-frac', String(k.lrfu_top_frac))
      if (engineSupportsLrfu) args.push('--kvmem-score-agg', k.score_agg)
      if (basic.flash_attn) args.push('--flash-attn', 'on')
      if (k.enable_thinking) args.push('--enable-thinking', '--reasoning-budget', String(k.reasoning_budget))
      if (config.chat_template_file.trim()) args.push('--chat-template-file', quote(config.chat_template_file.trim()))
      // Mirror _build_kvmem_command: MTP needs a model with a merged MTP head.
      if (mtp.enabled) args.push('--spec-type', 'draft-mtp', '--spec-draft-n-max', String(Math.max(1, mtp.draft_n_max)), '--spec-kv-dtype', 'f16', '--kvmem-mtp-state', k.mtp_state)
      else args.push('--spec-type', 'none')
      if (config.extra_params.trim()) args.push(config.extra_params.trim())
      return args.join(' ')
    }
    const args: string[] = ['llama-server', '-m', quote(config.model_path || '<model.gguf>'), '-c', String(basic.ctx_size)]
    if (config.mmproj_path) { args.push('--mmproj', quote(config.mmproj_path)); args.push(config.mmproj_gpu ? '--mmproj-offload' : '--no-mmproj-offload') }
    if (basic.fit_enabled) { args.push('--fit', 'on'); if (basic.fit_target > 0) args.push('--fit-target', String(basic.fit_target)) }
    else args.push('-ngl', String(basic.ngl_enabled ? basic.ngl : 0))
    args.push('-t', String(basic.threads), '-np', String(basic.parallel), ...(basic.mmap ? [] : ['--no-mmap']))
    if (basic.mlock) args.push('--mlock')
    if (basic.n_cpu_moe > 0) args.push('--n-cpu-moe', String(basic.n_cpu_moe))
    if (basic.kv_cache_quant_k) args.push('--cache-type-k', basic.kv_cache_quant_k)
    if (basic.kv_cache_quant_v) args.push('--cache-type-v', basic.kv_cache_quant_v)
    if (basic.enable_thinking) args.push('--reasoning', 'on')
    if (!basic.kv_offload) args.push('--no-kv-offload')
    if (basic.flash_attn) args.push('--flash-attn', 'on')
    if (!basic.kv_unified) args.push('--no-kv-unified')
    args.push('-b', String(basic.batch_size), '-ub', String(basic.ubatch_size))
    if (basic.context_shift) args.push('--context-shift')
    if (basic.cache_ram >= 0) args.push('--cache-ram', String(basic.cache_ram))
    args.push('--temp', String(sampling.temperature), '--top-k', String(sampling.top_k), '--top-p', String(sampling.top_p))
    if (sampling.min_p_enabled) args.push('--min-p', String(sampling.min_p))
    if (sampling.repeat_penalty_enabled) args.push('--repeat-penalty', String(sampling.repeat_penalty))
    if (sampling.presence_penalty_enabled) args.push('--presence-penalty', String(sampling.presence_penalty))
    if (mtp.enabled) {
      args.push('--spec-type', mtp.spec_type, '--spec-draft-n-max', String(mtp.draft_n_max))
      if (mtp.draft_n_min > 0) args.push('--spec-draft-n-min', String(mtp.draft_n_min))
      if (mtp.p_min !== 0) args.push('--spec-draft-p-min', String(mtp.p_min))
      if (mtp.p_split !== 0.1) args.push('--spec-draft-p-split', String(mtp.p_split))
    }
    if (config.system_prompt.trim()) args.push('--system-prompt', quote(config.system_prompt.trim()))
    args.push('--host', config.server.host, '--port', String(config.server.port))
    if (config.chat_template_file.trim()) args.push('--chat-template-file', quote(config.chat_template_file.trim()))
    if (config.extra_params.trim()) args.push(config.extra_params.trim())
    return args.join(' ')
  }, [config, basic, sampling, mtp, kvmem, ninfer, engineSupportsLrfu])

  const browseValue = browse ? config[browse.key] : ''

  return <>
    <div className={page.splitMain}>
      <div className={page.stack}>
        <Panel className={page.configBar} title="配置文件" actions={<div className={page.row}><Button size="small" onClick={exportConfig}><Upload size={14}/>导出</Button><Button size="small" onClick={() => importRef.current?.click()}><Download size={14}/>导入</Button></div>}>
          <div className={page.formGridThree}>
            <Field label="配置名称"><Input value={name} onChange={event => { setName(event.target.value); nameTouched.current = true }} /></Field>
            <Field label="已保存配置"><Select value={configs.includes(name) ? name : ''} onChange={event => requestLoad(event.target.value)}><option value="">选择配置</option>{configs.map(item => <option key={item}>{item}</option>)}</Select></Field>
            <div className={page.row} style={{ alignSelf: 'end' }}><Button tone="primary" disabled={!!operation} onClick={() => void attempt('保存', save)}><Save size={15}/>{operation === '保存' ? '保存中…' : '保存'}</Button><Button tone="danger" disabled={!!operation || name === 'default'} onClick={() => setConfirmRemove(true)}><Trash2 size={15}/>删除</Button></div>
            {pendingLoad && <div className={`${page.row} ${page.wide}`}><span className={page.hint}>有未保存的修改，载入「{pendingLoad}」将丢弃它们。</span><Button size="small" tone="danger" onClick={() => { const target = pendingLoad; setPendingLoad(''); void attempt('载入', () => load(target)) }}>丢弃并载入</Button><Button size="small" onClick={() => setPendingLoad('')}>取消</Button></div>}
          </div>
          {operationError && <p role="alert" className={page.error}>{operationError}</p>}
          {dirty && <p className={page.hint}>有未保存的修改，保存后可在运行页启动。</p>}
          <input ref={importRef} hidden type="file" accept=".json" onChange={event => void attempt('导入', () => importConfig(event.target.files?.[0]))} />
        </Panel>

        <Panel title="模型与运行目录">
          <div className={page.formGrid}>
            <Field label="推理引擎"><Select value={config.engine} onChange={event => switchEngine(event.target.value as AppConfig['engine'])}><option value="llama.cpp">本地 llama.cpp</option><option value="kvmem">KVMem(KV 缓存虚拟化)</option><option value="ninfer">NInfer(.ninfer 引擎)</option></Select></Field>
            <Field label="引擎目录"><div className={page.row}><Input value={config.llama_cpp_dir} placeholder="留空=使用内置引擎包" onChange={event => patch('llama_cpp_dir', event.target.value)} /><Button iconOnly title="浏览" onClick={() => setBrowse({ key: 'llama_cpp_dir', mode: 'folder' })}><FolderOpen size={16}/></Button></div></Field>
            <Field label={isNinfer ? 'NInfer 模型' : 'GGUF 模型'}><div className={page.row}><Input value={config.model_path} onChange={event => patch('model_path', event.target.value)} /><Button iconOnly title="浏览" onClick={() => setBrowse({ key: 'model_path', mode: 'file', extension: isNinfer ? '.ninfer' : '.gguf' })}><FolderOpen size={16}/></Button></div></Field>
            <Field label="MMProj"><div className={page.row}><Input value={config.mmproj_path} onChange={event => patch('mmproj_path', event.target.value)} /><Button iconOnly title="浏览" onClick={() => setBrowse({ key: 'mmproj_path', mode: 'file', extension: '.gguf' })}><FolderOpen size={16}/></Button></div></Field>
            {config.mmproj_path && <Field label="视觉投影器"><div className={page.row}><Switch checked={config.mmproj_gpu} onChange={mmproj_gpu => patch('mmproj_gpu', mmproj_gpu)} label="进显存"/></div></Field>}
            <Field label="监听模式"><Select value={config.server.mode} onChange={event => patch('server', { ...config.server, mode: event.target.value, host: event.target.value === 'lan' ? '0.0.0.0' : '127.0.0.1' })}><option value="local">本地 127.0.0.1</option><option value="lan">局域网 0.0.0.0</option></Select></Field>
            <Field label="监听地址"><Input value={config.server.host} onChange={event => patch('server', { ...config.server, host: event.target.value })} /></Field>
            <Field label="端口"><Input type="number" value={config.server.port} onChange={event => patch('server', { ...config.server, port: Number(event.target.value) })} /></Field>
          </div>
        </Panel>

        <Panel title="推理与显存">
          <div className={page.formGridThree}>
            {isNative && <NumberField label="上下文" value={basic.ctx_size} onChange={ctx_size => patchBasic({ ctx_size })} />}
            {isNative && <NumberField label="CPU 线程" value={basic.threads} onChange={threads => patchBasic({ threads })} />}
            {isNative && <NumberField label="并行数" value={basic.parallel} onChange={parallel => patchBasic({ parallel })} />}
            {!isNinfer && <Field label="GPU 卸载"><div className={page.row}><Switch checked={basic.ngl_enabled} disabled={basic.fit_enabled && isNative} onChange={ngl_enabled => patchBasic({ ngl_enabled })} label="NGL"/><Input type="number" disabled={!basic.ngl_enabled || (basic.fit_enabled && isNative)} value={basic.ngl} onChange={event => patchBasic({ ngl: Number(event.target.value) })}/></div></Field>}
            {isNative && <Field label="自动适配 GPU"><div className={page.row}><Switch checked={basic.fit_enabled} onChange={fit_enabled => patchBasic({ fit_enabled })} label="Fit"/><Input type="number" disabled={!basic.fit_enabled} value={basic.fit_target} onChange={event => patchBasic({ fit_target: Number(event.target.value) })}/></div></Field>}
            {isNative && <NumberField label="MoE CPU 层" value={basic.n_cpu_moe} onChange={n_cpu_moe => patchBasic({ n_cpu_moe })} />}
            {isNative && <Field label="KV Cache K"><Select value={basic.kv_cache_quant_k} onChange={event => patchBasic({ kv_cache_quant_k: event.target.value })}><option value="">默认</option><option>q8_0</option><option>q4_0</option></Select></Field>}
            {isNative && <Field label="KV Cache V"><Select value={basic.kv_cache_quant_v} onChange={event => patchBasic({ kv_cache_quant_v: event.target.value })}><option value="">默认</option><option>q8_0</option><option>q4_0</option></Select></Field>}
            {isNative && <NumberField label="Cache RAM MiB" value={basic.cache_ram} onChange={cache_ram => patchBasic({ cache_ram })} />}
            {!isNative && <p className={page.hint} style={{ gridColumn: '1 / -1', margin: 0 }}>仅 llama.cpp 引擎使用的参数已隐藏{isKvmem ? '；上下文由下方 KVMem 面板的「逻辑工作区」控制' : '；上下文由下方 NInfer 面板的「逻辑上下文」控制'}。</p>}
          </div>
          <div className={page.wrap} style={{ marginTop: 14 }}>
            {isNative && <Switch checked={basic.mmap} onChange={mmap => patchBasic({ mmap })} label="MMap"/>}
            {isNative && <Switch checked={basic.mlock} onChange={mlock => patchBasic({ mlock })} label="MLock"/>}
            {isNative && <Switch checked={basic.kv_offload} onChange={kv_offload => patchBasic({ kv_offload })} label="KV GPU"/>}
            {isNative && <Switch checked={basic.flash_attn} onChange={flash_attn => patchBasic({ flash_attn })} label="Flash Attention"/>}
            {isNative && <Switch checked={basic.kv_unified} onChange={kv_unified => patchBasic({ kv_unified })} label="Unified KV"/>}
            {isNative && <Switch checked={basic.context_shift} onChange={context_shift => patchBasic({ context_shift })} label="Context Shift"/>}
            <Switch checked={isKvmem ? kvmem.enable_thinking : basic.enable_thinking} onChange={value => isKvmem ? patchKvmem({ enable_thinking: value }) : patchBasic({ enable_thinking: value })} label="思考(默认)"/>
          </div>
          {isNative && <div className={page.formGrid} style={{ marginTop: 12 }}><NumberField label="Batch" value={basic.batch_size} onChange={batch_size => patchBasic({ batch_size })}/><NumberField label="Micro Batch" value={basic.ubatch_size} onChange={ubatch_size => patchBasic({ ubatch_size })}/></div>}

        </Panel>

        {isKvmem && (
          <details className={page.advanced}><summary>KVMem(KV 缓存虚拟化)<span>上下文、缓存与检索参数</span></summary><div className={page.advancedBody}>
            <div className={page.formGridThree}>
              <NumberField label="逻辑工作区" value={kvmem.workspace} onChange={workspace => patchKvmem({ workspace })}/>
              <NumberField label="GPU 预算" value={kvmem.budget} onChange={budget => patchKvmem({ budget })}/>
              <NumberField label="生成预留" value={kvmem.gen_reserve} onChange={gen_reserve => patchKvmem({ gen_reserve })}/>
              <NumberField label="块大小" value={kvmem.block_tokens} onChange={block_tokens => patchKvmem({ block_tokens })}/>
              <NumberField label="逻辑批次" value={kvmem.batch} onChange={batch => patchKvmem({ batch })}/>
              <NumberField label="微批" value={kvmem.ubatch} onChange={ubatch => patchKvmem({ ubatch })}/>
              <Field label="KV 类型"><Select value={kvmem.kv_dtype} onChange={event => patchKvmem({ kv_dtype: event.target.value })}><option>q8_0</option><option>q5_0</option><option>q4_0</option></Select></Field>
              <Field label="查询策略"><Input value={kvmem.query_policy} onChange={event => patchKvmem({ query_policy: event.target.value })}/></Field>
              <Field label="MTP 状态"><Select value={kvmem.mtp_state} onChange={event => patchKvmem({ mtp_state: event.target.value })}><option value="snapshots">snapshots(当前构建)</option><option value="replay">replay(当前二进制不支持)</option></Select></Field>
              <NumberField label="推理预算" value={kvmem.reasoning_budget} disabled={!kvmem.enable_thinking} onChange={reasoning_budget => patchKvmem({ reasoning_budget })}/>
            </div>
            <div className={page.formGridThree} style={{ marginTop: 14 }}>
              <RetrievalFields value={kvmem} unit={kvmem.block_tokens} supported={engineSupportsLrfu} onChange={patchKvmem}/>
            </div>
            {retrievalOverflow(alignTo(kvmem.sink_tokens, kvmem.block_tokens) + alignTo(kvmem.recent_tokens, kvmem.block_tokens), kvmem.budget, `${kvmem.block_tokens}-token 块`)}
            <p className={page.hint}>-c 是逻辑 KV 工作区，不是显存上限；显存由「GPU 预算 + 生成预留」决定，两者之和不能超过工作区。sink/recent 是从预算里划走的常驻窗口，不是额外显存；对齐后之和超过预算引擎会拒绝启动。「命中比例」控制累加分数的范围，不是保留 90% KV。「思考(默认)」开关在上方共用一行；采样参数在此引擎下走请求级设置。</p>
          </div></details>
        )}

        {isNinfer && (
          <details className={page.advanced}><summary>NInfer(内置 KVMem v0.18 引擎)<span>显存分层、检索与投机解码</span></summary><div className={page.advancedBody}>
            <div className={page.formGridThree}>
              <NumberField label="逻辑上下文" value={ninfer.max_context} onChange={max_context => patchNinfer({ max_context })}/>
              <NumberField label="GPU 预算 B" value={ninfer.budget} onChange={budget => patchNinfer({ budget })}/>
              <NumberField label="生成预留 R" value={ninfer.gen_reserve} onChange={gen_reserve => patchNinfer({ gen_reserve })}/>
              <NumberField label="主机预算 MiB" value={ninfer.host_kv_mib} onChange={host_kv_mib => patchNinfer({ host_kv_mib: Math.max(0, host_kv_mib) })}/>
              <NumberField label="保留会话" value={ninfer.sessions} onChange={sessions => patchNinfer({ sessions: Math.min(16, Math.max(1, sessions)) })}/>
              <Field label="KV 类型"><Select value={ninfer.kv_dtype} onChange={event => patchNinfer({ kv_dtype: event.target.value })}><option value="k8v4">k8v4(交付档)</option><option>bf16</option><option value="int8">int8</option><option>fp8</option><option>rk8v4</option><option>rk4v4</option><option>rk4v4-e8</option><option>rk2v4-e8</option><option>nvfp4</option></Select></Field>
              <NumberField label="预填块" value={ninfer.prefill_chunk} onChange={prefill_chunk => patchNinfer({ prefill_chunk: Math.max(0, prefill_chunk) })}/>
              <NumberField label="并发数" value={ninfer.max_concurrency} onChange={max_concurrency => patchNinfer({ max_concurrency: Math.min(8, Math.max(1, max_concurrency)) })}/>
              <NumberField label="输出上限" value={ninfer.default_max_tokens} onChange={default_max_tokens => patchNinfer({ default_max_tokens: Math.max(0, default_max_tokens) })}/>
              <Field label="CUDA Graphs"><Switch checked={ninfer.cuda_graph} onChange={cuda_graph => patchNinfer({ cuda_graph })} label={ninfer.cuda_graph ? '开' : '关(8GB 建议)'}/></Field>
              <Field label="快预填核"><Switch checked={ninfer.fast_prefill} onChange={fast_prefill => patchNinfer({ fast_prefill })} label="仅 int8/rk*"/></Field>
              <NumberField label="思考预算" value={ninfer.default_thinking_budget} disabled={!basic.enable_thinking} onChange={default_thinking_budget => patchNinfer({ default_thinking_budget: Math.max(0, default_thinking_budget) })}/>
            </div>
            <div className={page.formGridThree} style={{ marginTop: 14 }}>
              <RetrievalFields value={ninfer} unit={KV_PAGE} supported={engineSupportsLrfu} onChange={patchNinfer}/>
            </div>
            {retrievalOverflow(alignTo(ninfer.sink_tokens, KV_PAGE) + alignTo(ninfer.recent_tokens, KV_PAGE), alignTo(ninfer.budget, KV_PAGE), '64-token 页')}
            <div className={page.formGridThree} style={{ marginTop: 14 }}>
              <Field label="SSD 分层目录"><Input value={ninfer.disk_path} placeholder="留空=只用 RAM" onChange={event => patchNinfer({ disk_path: event.target.value })}/></Field>
              <NumberField label="SSD 配额 MiB" value={ninfer.disk_mib} disabled={!ninfer.disk_path.trim()} onChange={disk_mib => patchNinfer({ disk_mib: Math.max(0, disk_mib) })}/>
              <Field label="分层说明"><span className={page.hint}>SSD 文件只在当前进程有效，不支持重启恢复或跨后端迁移。</span></Field>
            </div>
            <div className={page.formGridThree} style={{ marginTop: 14 }}>
              <Field label="投机解码"><Select value={ninfer.spec} onChange={event => patchNinfer({ spec: event.target.value })}><option value="none">关闭</option><option value="mtp">mtp</option><option value="dflash">dflash</option><option value="dflash2">dflash2</option></Select></Field>
              <NumberField label="草稿 Token" value={ninfer.draft_tokens} disabled={ninfer.spec === 'none'} onChange={draft_tokens => patchNinfer({ draft_tokens: Math.min(15, Math.max(1, draft_tokens)) })}/>
              <Field label="自适应 MTP"><Switch checked={ninfer.adaptive_mtp} disabled={ninfer.spec !== 'mtp'} onChange={adaptive_mtp => patchNinfer({ adaptive_mtp })} label="adaptive"/></Field>
              <NumberField label="ngram 草稿" value={ninfer.ngram_draft_tokens} disabled={ninfer.spec === 'none'} onChange={ngram_draft_tokens => patchNinfer({ ngram_draft_tokens: Math.min(63, Math.max(0, ngram_draft_tokens)) })}/>
              <NumberField label="ngram 最短匹配" value={ninfer.ngram_min_match} disabled={ninfer.spec === 'none' || ninfer.ngram_draft_tokens <= 0} onChange={ngram_min_match => patchNinfer({ ngram_min_match: Math.min(64, Math.max(4, ngram_min_match)) })}/>
              <Field label="思考档位"><Select value={ninfer.reasoning_effort} disabled={!basic.enable_thinking} onChange={event => patchNinfer({ reasoning_effort: event.target.value })}><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></Select></Field>
              <Field label="模型名(--model-id)"><Input value={ninfer.model_id} placeholder="留空=工件元数据" onChange={event => patchNinfer({ model_id: event.target.value })}/></Field>
            </div>
            <p className={page.hint}>B + R 是常驻显存的设备 KV，按 64-token 页向下取整；两者之和不能超过逻辑上下文。sink/recent 从 B 里划走，对齐后之和超过 B 引擎会拒启。主机预算与 SSD 是受管数据配额，不是进程总内存上限。Top-K 引擎侧上限 20，超出会自动截断。官方 16GB 配方是 B/R 36864/16384 + 主机 12288MiB，8GB 卡请按显存账往下压。</p>
          </div></details>
        )}

        <details className={page.advanced}><summary>采样与投机解码<span>温度、概率与 MTP</span></summary><div className={page.advancedBody}>
          <div className={page.formGridThree}>
            <NumberField label="温度" value={sampling.temperature} step="0.05" onChange={temperature => patchSampling({ temperature })}/>
            <NumberField label="Top-K" value={sampling.top_k} onChange={top_k => patchSampling({ top_k })}/>
            <NumberField label="Top-P" value={sampling.top_p} step="0.01" onChange={top_p => patchSampling({ top_p })}/>
            <OptionalNumber label="Min-P" enabled={sampling.min_p_enabled} value={sampling.min_p} step="0.01" onEnabled={min_p_enabled => patchSampling({ min_p_enabled })} onChange={min_p => patchSampling({ min_p })}/>
            {!isNinfer && <OptionalNumber label="重复惩罚" enabled={sampling.repeat_penalty_enabled} value={sampling.repeat_penalty} step="0.05" onEnabled={repeat_penalty_enabled => patchSampling({ repeat_penalty_enabled })} onChange={repeat_penalty => patchSampling({ repeat_penalty })}/>}
            <OptionalNumber label="存在惩罚" enabled={sampling.presence_penalty_enabled} value={sampling.presence_penalty} step="0.1" onEnabled={presence_penalty_enabled => patchSampling({ presence_penalty_enabled })} onChange={presence_penalty => patchSampling({ presence_penalty })}/>
          </div>
          {!isNinfer && <div className={page.formGridThree} style={{ marginTop: 14 }}>
            <Field label="MTP"><Switch checked={mtp.enabled} onChange={enabled => patchMtp({ enabled })} label="启用投机解码"/></Field>
            <NumberField label="最大草稿 Token" value={mtp.draft_n_max} disabled={!mtp.enabled} onChange={draft_n_max => patchMtp({ draft_n_max })}/>
            {!isKvmem && <NumberField label="最小草稿 Token" value={mtp.draft_n_min} disabled={!mtp.enabled} onChange={draft_n_min => patchMtp({ draft_n_min })}/>}
            {!isKvmem && <NumberField label="P Min" value={mtp.p_min} step="0.01" disabled={!mtp.enabled} onChange={p_min => patchMtp({ p_min })}/>}
            {!isKvmem && <NumberField label="P Split" value={mtp.p_split} step="0.01" disabled={!mtp.enabled} onChange={p_split => patchMtp({ p_split })}/>}
          </div>}
          {isKvmem && <p className={page.hint}>实验性:需要已合并 MTP 头的模型(见 KVMem prism.3 说明);最小草稿与 P 阈值仅 llama.cpp 引擎使用。</p>}
        </div></details>

        <details className={page.advanced}><summary>提示词与附加参数<span>系统提示词、模板与扩展参数</span></summary><div className={page.advancedBody}>
          <div className={page.formGrid}><Field label="系统提示词"><Textarea value={config.system_prompt} onChange={event => patch('system_prompt', event.target.value)}/></Field><Field label="附加参数"><Textarea value={config.extra_params} onChange={event => patch('extra_params', event.target.value)}/></Field></div>
          <Field label="聊天模板文件（可选，--chat-template-file）" className={page.wide}><div className={page.row}><Input value={config.chat_template_file} onChange={event => patch('chat_template_file', event.target.value)} /><Button iconOnly title="浏览" onClick={() => setBrowse({ key: 'chat_template_file', mode: 'file' })}><FolderOpen size={16}/></Button></div></Field>
          <p className={page.hint}>编译命令已移至「维护」页的编译面板。</p>
        </div></details>
      </div>

      <Panel title="资源与启动命令" icon={<RefreshCw size={15}/>} className={page.sticky} actions={<div className={page.row}><Button size="small" onClick={() => setImportOpen(true)}><ClipboardPaste size={14}/>从命令导入</Button><Button size="small" onClick={() => { void navigator.clipboard.writeText(command); toast('命令已复制') }}><Copy size={14}/>复制</Button></div>}>
        <ResourceUsage usage={usage}/>
        <div className={page.commandLabel}>启动命令</div><pre className={page.code}>{command}</pre>
        <p className={page.hint} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Badge tone={detectQuery.data?.found ? 'good' : 'bad'}>{detectQuery.data?.found ? '引擎二进制已找到' : '未找到引擎二进制'}</Badge>
          {detectQuery.data?.found && <span>{detectQuery.data.bundled ? '内置包：' : ''}{detectQuery.data.path}</span>}
          {detectQuery.data?.found && <Badge tone={detectQuery.data.lrfu ? 'good' : 'warn'}>{detectQuery.data.lrfu ? '支持 LRFU 检索' : '此构建不支持 LRFU'}</Badge>}
          {detectQuery.isFetching && <span>检测中…</span>}
        </p>
        <p className={page.hint}>预览与 ProcessManager 使用相同的参数语义；保存配置后运行页会使用当前值。</p>
      </Panel>
    </div>
    {confirmRemove && <ConfirmDialog title={`删除配置「${name}」？`} description="此档案将被永久删除，删除后会载入默认配置。需要保留时请先导出。" confirmLabel="删除配置" pending={operation === '删除'} onClose={() => setConfirmRemove(false)} onConfirm={() => { setConfirmRemove(false); void attempt('删除', remove) }}/>}
    {browse && (
      <FileBrowser mode={browse.mode} extension={browse.extension} initialPath={browseValue} onClose={() => setBrowse(null)} onSelect={value => { patch(browse.key, value); setBrowse(null) }}/>
    )}
    {importOpen && <Modal title="从启动命令导入" onClose={() => setImportOpen(false)} className={page.importModal}>
        <Panel className={page.importDialog} title="从启动命令导入" actions={<Button size="small" onClick={() => void pasteFromClipboard()}><ClipboardPaste size={14}/>粘贴</Button>}>
          <Textarea aria-label="启动命令文本" rows={7} className={page.importText} value={importText} data-autofocus onChange={event => setImportText(event.target.value)} placeholder={'llama-server -m "E:\\models\\model.gguf" --host 127.0.0.1 --port 8081 -ngl 99 -c 32768 -fa on ...'} />
          <p className={page.hint}>已识别的字段会回填到左侧表单；无法识别的参数会原样放入「附加参数」，不会丢失。</p>
          <div className={page.row} style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            <Button onClick={() => setImportOpen(false)}>取消</Button>
            <Button tone="primary" disabled={!importText.trim()} onClick={importCommand}>解析并应用</Button>
          </div>
        </Panel>
      </Modal>}
  </>
}

function quote(value: string) { return /\s/.test(value) ? `"${value}"` : value }

// The engines allocate KV in fixed units — llama-kvmem-server uses
// --kvmem-block-tokens, NInfer uses 64-token pages — and round every token
// count down to a whole unit, so the form and the preview must show what the
// engine will actually receive.
const KV_PAGE = 64
function alignTo(value: number, unit: number) { const u = Math.max(1, unit); return Math.max(0, Math.floor(value / u) * u) }

interface RetrievalBlock {
  sink_tokens: number
  recent_tokens: number
  lrfu: boolean
  lrfu_lambda: number
  lrfu_top_frac: number
  score_agg: string
}

// Both KVMem engines share one retrieval vocabulary (--kvmem-sink/recent,
// --kvmem-lrfu*, --kvmem-score-agg), so one field set serves both panels.
function RetrievalFields({ value, unit, supported, onChange }: { value: RetrievalBlock; unit: number; supported: boolean; onChange: (patch: Partial<RetrievalBlock>) => void }) {
  return <>
    <NumberField label={`常驻前缀 (${unit}对齐)`} value={value.sink_tokens} onChange={sink_tokens => onChange({ sink_tokens })}/>
    <NumberField label="常驻最新段" value={value.recent_tokens} onChange={recent_tokens => onChange({ recent_tokens })}/>
    <Field label="LRFU 历史加权"><Switch checked={value.lrfu} disabled={!supported} onChange={lrfu => onChange({ lrfu })} label={supported ? (value.lrfu ? '开' : '关') : '当前引擎不支持'}/></Field>
    <NumberField label="衰减 λ" value={value.lrfu_lambda} step="0.05" disabled={!value.lrfu || !supported} onChange={lrfu_lambda => onChange({ lrfu_lambda })}/>
    <NumberField label="命中比例" value={value.lrfu_top_frac} step="0.05" disabled={!value.lrfu || !supported} onChange={lrfu_top_frac => onChange({ lrfu_top_frac })}/>
    <Field label="GQA 聚合"><Select disabled={!supported} value={value.score_agg} onChange={event => onChange({ score_agg: event.target.value })}><option value="mean">mean</option><option value="max">max (v0.18 配方)</option></Select></Field>
  </>
}

// The engine refuses to start when the pinned windows do not fit in B, so
// flag it here where the numbers can still be changed.
function retrievalOverflow(pinned: number, budget: number, unitLabel: string) {
  if (!pinned || pinned <= budget) return null
  return <p role="alert" className={page.error}>常驻窗口合计 {pinned} token 已超过 GPU 预算 {budget}（按{unitLabel}向下对齐后），引擎会拒绝启动。</p>
}


function NumberField({ label, value, onChange, step = '1', disabled = false }: { label: string; value: number; onChange: (value: number) => void; step?: string; disabled?: boolean }) {
  return <Field label={label}><Input type="number" step={step} disabled={disabled} value={value} onChange={event => onChange(Number(event.target.value))}/></Field>
}
function OptionalNumber({ label, enabled, value, onEnabled, onChange, step }: { label: string; enabled: boolean; value: number; onEnabled: (value: boolean) => void; onChange: (value: number) => void; step: string }) {
  return <Field label={label}><div className={page.row}><Switch checked={enabled} onChange={onEnabled} label=""/><Input type="number" step={step} disabled={!enabled} value={value} onChange={event => onChange(Number(event.target.value))}/></div></Field>
}
