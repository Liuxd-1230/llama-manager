import { ClipboardPaste, Copy, Download, FolderOpen, RefreshCw, Save, Trash2, Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  const [nameTouched, setNameTouched] = useState(false)
  const [pendingLoad, setPendingLoad] = useState('')
  const requestLoad = (selected: string) => {
    if (!selected) return
    if (dirty) { setPendingLoad(selected); return }
    void load(selected)
  }
  const currentNameQuery = useQuery({ queryKey: ['current-profile'], queryFn: () => api<{ name: string }>('/api/profiles/current'), staleTime: 0 })
  // Direct read of the model file the current config points at — no second
  // query to correlate, so the estimator's weight term is always live.
  const modelInfoQuery = useQuery({
    queryKey: ['model-info', config.model_path, config.engine],
    queryFn: () => api<{ size_mb: number; meta: Record<string, unknown> }>(`/api/model-info?path=${encodeURIComponent(config.model_path)}`),
    enabled: !!config.model_path.trim(),
    staleTime: 60000,
  })
  const usage = estimateFromConfig(config, modelInfoQuery.data?.size_mb || 0, modelInfoQuery.data?.meta)
  useEffect(() => { if (!nameTouched && currentNameQuery.data?.name) setName(currentNameQuery.data.name) }, [currentNameQuery.data, nameTouched])
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
    queryFn: () => api<{ found: boolean; path: string }>(`/api/detect-server?llama_cpp_dir=${encodeURIComponent(config.llama_cpp_dir)}&engine=${config.engine}`),
    enabled: !!config.llama_cpp_dir.trim(),
    staleTime: 30000,
  })
  const refreshNames = async () => {
    try { setConfigs((await api<{ configs: string[] }>('/api/config/list')).configs || []) } catch { setConfigs([]) }
  }
  useEffect(() => { void refreshNames() }, [])

  const save = async () => {
    await api('/api/config/save-as', { method: 'POST', body: JSON.stringify({ name: name || 'default', config }) })
    toast(`配置已保存：${name || 'default'}`); await refreshNames()
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['config'] }), queryClient.invalidateQueries({ queryKey: ['current-profile'] }), queryClient.invalidateQueries({ queryKey: ['profiles'] })])
  }
  const load = async (selected: string) => {
    if (!selected) return
    await api<AppConfig>('/api/config/load', { method: 'POST', body: JSON.stringify({ name: selected }) })
    setName(selected); setNameTouched(true); toast(`已载入：${selected}`)
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['config'] }), queryClient.invalidateQueries({ queryKey: ['current-profile'] })])
  }
  const remove = async () => {
    if (!name || name === 'default') return toast('默认配置不能删除')
    await api('/api/config/delete', { method: 'POST', body: JSON.stringify({ name }) })
    setName('default'); toast('配置已删除'); await refreshNames()
  }
  const exportConfig = () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${name || 'config'}.json`; link.click(); URL.revokeObjectURL(link.href)
  }
  const importConfig = async (file?: File) => {
    if (!file) return
    const imported = await api<AppConfig>('/api/config/import', { method: 'POST', body: JSON.stringify({ content: await file.text() }) })
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
      const n = ninfer
      const args: string[] = ['ninfer-serve-89', quote(config.model_path || '<model.ninfer>')]
      args.push('--host', config.server.host, '--port', String(config.server.port))
      args.push('--max-context', String(n.max_context))
      if (n.kv_capacity > 0) args.push('--kv-capacity', String(n.kv_capacity))
      args.push('--kv-dtype', n.kv_dtype, '--host-kv-mib', String(n.host_kv_mib))
      if (n.prefill_chunk > 0) args.push('--prefill-chunk', String(n.prefill_chunk))
      args.push('--max-concurrency', String(n.max_concurrency), '--default-max-tokens', String(n.default_max_tokens))
      if (!n.cuda_graph) args.push('--no-cuda-graph')
      args.push('--cors')
      if (n.spec !== 'none') {
        args.push('--spec', n.spec, '--draft-tokens', String(n.draft_tokens))
        if (n.adaptive_mtp) args.push('--adaptive-mtp')
      }
      args.push('--temperature', String(sampling.temperature), '--top-p', String(sampling.top_p), '--top-k', String(Math.max(0, Math.min(sampling.top_k, 20))))
      if (sampling.min_p_enabled) args.push('--min-p', String(sampling.min_p))
      if (sampling.presence_penalty_enabled) args.push('--presence-penalty', String(sampling.presence_penalty))
      args.push('--default-reasoning-effort', basic.enable_thinking ? n.reasoning_effort : 'none')
      if (n.model_id.trim()) args.push('--model-id', n.model_id.trim())
      if (config.extra_params.trim()) args.push(config.extra_params.trim())
      return args.join(' ')
    }
    if (config.engine === 'kvmem') {
      const k = kvmem
      const args: string[] = ['llama-kvmem-server', '-m', quote(config.model_path || '<model.gguf>')]
      if (config.mmproj_path) { args.push('--mmproj', quote(config.mmproj_path)); args.push(config.mmproj_gpu ? '--mmproj-offload' : '--no-mmproj-offload') }
      if (basic.ngl_enabled) args.push('-ngl', String(basic.ngl))
      args.push('--host', config.server.host, '--port', String(config.server.port))
      args.push('-c', String(k.workspace), '-b', String(k.batch), '--ubatch-size', String(k.ubatch), '-n', String(k.gen_reserve))
      args.push('--kvmem-budget', String(k.budget), '--kvmem-gen-reserve', String(k.gen_reserve), '--kvmem-block-tokens', String(k.block_tokens), '--kvmem-query-policy', k.query_policy, '--kvmem-query-replay', 'auto', '--kv-dtype', k.kv_dtype)
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
  }, [config, basic, sampling, mtp, kvmem])

  const browseValue = browse ? config[browse.key] : ''

  return <>
    <div className={page.splitMain}>
      <div className={page.stack}>
        <Panel title="配置文件" actions={<div className={page.row}><Button size="small" onClick={exportConfig}><Upload size={14}/>导出</Button><Button size="small" onClick={() => importRef.current?.click()}><Download size={14}/>导入</Button></div>}>
          <div className={page.formGridThree}>
            <Field label="配置名称"><Input value={name} onChange={event => { setName(event.target.value); setNameTouched(true) }} /></Field>
            <Field label="已保存配置"><Select value={configs.includes(name) ? name : ''} onChange={event => requestLoad(event.target.value)}><option value="">选择配置</option>{configs.map(item => <option key={item}>{item}</option>)}</Select></Field>
            <div className={page.row} style={{ alignSelf: 'end' }}><Button tone="primary" onClick={() => void save()}><Save size={15}/>保存</Button><Button tone="danger" onClick={() => void remove()}><Trash2 size={15}/>删除</Button></div>
            {pendingLoad && <div className={`${page.row} ${page.wide}`}><span className={page.hint}>有未保存的修改，载入「{pendingLoad}」将丢弃它们。</span><Button size="small" tone="danger" onClick={() => { const target = pendingLoad; setPendingLoad(''); void load(target) }}>丢弃并载入</Button><Button size="small" onClick={() => setPendingLoad('')}>取消</Button></div>}
          </div>
          <input ref={importRef} hidden type="file" accept=".json" onChange={event => void importConfig(event.target.files?.[0])} />
        </Panel>

        <Panel title="模型与运行目录">
          <div className={page.formGrid}>
            <Field label="推理引擎"><Select value={config.engine} onChange={event => switchEngine(event.target.value as AppConfig['engine'])}><option value="llama.cpp">本地 llama.cpp</option><option value="kvmem">KVMem(KV 缓存虚拟化)</option><option value="ninfer">NInfer(.ninfer 引擎)</option></Select></Field>
            <Field label="引擎目录"><div className={page.row}><Input value={config.llama_cpp_dir} onChange={event => patch('llama_cpp_dir', event.target.value)} /><Button iconOnly title="浏览" onClick={() => setBrowse({ key: 'llama_cpp_dir', mode: 'folder' })}><FolderOpen size={16}/></Button></div></Field>
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
          <div style={{ marginTop: 14 }}>
            {[
              { title: '预计显存', est: usage.vram, budget: 8, warn: 6.5, line: '安全线 7.4 / 8.0 GB', warnText: '⚠ 超过 7.4GB 安全线：可能启动被拒或推理中 OOM。' },
              { title: '预计内存', est: { ...usage.ram, over: false }, budget: 16, warn: 12, line: '', warnText: '' },
            ].map(bar => <div key={bar.title} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-3)', marginBottom: 5 }}>
                <span>{bar.title}（估算系数基于 Bonsai 27B 实测{bar.title.includes('显存') ? '，KV 取自模型几何' : ''}）：{bar.est.parts.map(p => `${p.label} ${p.gb.toFixed(2)}`).join(' + ')} ≈ <b style={{ color: bar.est.over ? 'var(--red)' : 'var(--text)' }}>{bar.est.totalGb.toFixed(2)} GB</b></span>
                {bar.line && <span>{bar.line}</span>}
              </div>
              <div style={{ height: 8, borderRadius: 5, background: 'var(--line)', overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, (bar.est.totalGb / bar.budget) * 100)}%`, height: '100%', borderRadius: 5, transition: 'width .25s ease, background .25s ease', background: bar.est.over ? 'var(--red)' : bar.est.totalGb > bar.warn ? 'var(--yellow)' : 'var(--green)' }}/>
              </div>
              {bar.warnText && bar.est.over && <p className={page.hint} style={{ color: 'var(--red)', margin: '5px 0 0' }}>{bar.warnText}</p>}
            </div>)}
          </div>
        </Panel>

        {isKvmem && (
          <Panel title="KVMem(KV 缓存虚拟化)">
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
            <p className={page.hint}>-c 是逻辑 KV 工作区，不是显存上限；显存由「GPU 预算 + 生成预留」决定，两者之和不能超过工作区。「思考(默认)」开关在上方共用一行。采样参数在此引擎下走请求级设置。</p>
          </Panel>
        )}

        {isNinfer && (
          <Panel title="NInfer(.ninfer 引擎)">
            <div className={page.formGridThree}>
              <NumberField label="逻辑上下文" value={ninfer.max_context} onChange={max_context => patchNinfer({ max_context })}/>
              <NumberField label="设备池(token)" value={ninfer.kv_capacity} onChange={kv_capacity => patchNinfer({ kv_capacity: Math.max(0, kv_capacity) })}/>
              <NumberField label="主机池 MiB" value={ninfer.host_kv_mib} onChange={host_kv_mib => patchNinfer({ host_kv_mib: Math.max(0, host_kv_mib) })}/>
              <Field label="KV 类型"><Select value={ninfer.kv_dtype} onChange={event => patchNinfer({ kv_dtype: event.target.value })}><option value="k8v4">k8v4(交付档)</option><option>bf16</option><option>int8</option><option>fp8</option><option>rk8v4</option><option>rk4v4</option><option>rk4v4-e8</option><option>rk2v4-e8</option><option>nvfp4</option></Select></Field>
              <NumberField label="预填块" value={ninfer.prefill_chunk} onChange={prefill_chunk => patchNinfer({ prefill_chunk: Math.max(0, prefill_chunk) })}/>
              <NumberField label="并发数" value={ninfer.max_concurrency} onChange={max_concurrency => patchNinfer({ max_concurrency: Math.min(8, Math.max(1, max_concurrency)) })}/>
              <NumberField label="输出上限" value={ninfer.default_max_tokens} onChange={default_max_tokens => patchNinfer({ default_max_tokens: Math.max(0, default_max_tokens) })}/>
              <Field label="CUDA Graphs"><Switch checked={ninfer.cuda_graph} onChange={cuda_graph => patchNinfer({ cuda_graph })} label={ninfer.cuda_graph ? '开' : '关(8GB 建议)'}/></Field>
              <NumberField label="检索窗口" value={ninfer.kv_window} onChange={kv_window => patchNinfer({ kv_window: Math.max(0, kv_window) })}/>
              <NumberField label="检索取回" value={ninfer.kv_retrieve} disabled={ninfer.kv_window <= 0} onChange={kv_retrieve => patchNinfer({ kv_retrieve: Math.max(0, kv_retrieve) })}/>
              <Field label="PTQ1 快路"><Switch checked={ninfer.ptq1_fast} onChange={ptq1_fast => patchNinfer({ ptq1_fast })} label="NINFER_TERNARY_PTQ1_FAST"/></Field>
              <Field label="思考档位"><Select value={ninfer.reasoning_effort} disabled={!basic.enable_thinking} onChange={event => patchNinfer({ reasoning_effort: event.target.value })}><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></Select></Field>
              <Field label="投机解码"><Select value={ninfer.spec} onChange={event => patchNinfer({ spec: event.target.value })}><option value="none">关闭</option><option value="mtp">mtp</option><option value="dflash">dflash</option><option value="dflash2">dflash2</option></Select></Field>
              <NumberField label="草稿 Token" value={ninfer.draft_tokens} disabled={ninfer.spec === 'none'} onChange={draft_tokens => patchNinfer({ draft_tokens: Math.min(15, Math.max(1, draft_tokens)) })}/>
              <Field label="自适应 MTP"><Switch checked={ninfer.adaptive_mtp} disabled={ninfer.spec !== 'mtp'} onChange={adaptive_mtp => patchNinfer({ adaptive_mtp })} label="adaptive"/></Field>
              <Field label="模型名(--model-id)"><Input value={ninfer.model_id} placeholder="留空=工件元数据" onChange={event => patchNinfer({ model_id: event.target.value })}/></Field>
            </div>
            <p className={page.hint}>显存账：主机池页数 + 设备池页数 ≥ 逻辑上下文页数（约 25 KiB 主机池/token）。8GB 卡参考：池 4032(63 页) + 预填块 256 + CUDA Graphs 关。检索打分随「检索窗口」自动开启；设备池下限 4032 已测，别再压。Top-K 引擎侧上限 20，超出会自动截断。</p>
          </Panel>
        )}

        <Panel title={isKvmem ? '采样与 MTP(实验)' : isNinfer ? '采样' : '采样与 MTP'}>
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
        </Panel>

        <Panel title="提示词与附加参数">
          <div className={page.formGrid}><Field label="系统提示词"><Textarea value={config.system_prompt} onChange={event => patch('system_prompt', event.target.value)}/></Field><Field label="附加参数"><Textarea value={config.extra_params} onChange={event => patch('extra_params', event.target.value)}/></Field></div>
          <Field label="聊天模板文件（可选，--chat-template-file）" className={page.wide}><div className={page.row}><Input value={config.chat_template_file} onChange={event => patch('chat_template_file', event.target.value)} /><Button iconOnly title="浏览" onClick={() => setBrowse({ key: 'chat_template_file', mode: 'file' })}><FolderOpen size={16}/></Button></div></Field>
          <p className={page.hint}>编译命令已移至「维护」页的编译面板。</p>
        </Panel>
      </div>

      <Panel title="启动命令" icon={<RefreshCw size={15}/>} className={page.sticky} actions={<div className={page.row}><Button size="small" onClick={() => setImportOpen(true)}><ClipboardPaste size={14}/>从命令导入</Button><Button size="small" onClick={() => { void navigator.clipboard.writeText(command); toast('命令已复制') }}><Copy size={14}/>复制</Button></div>}>
        <pre className={page.code}>{command}</pre>
        {!!config.llama_cpp_dir.trim() && <p className={page.hint} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}><Badge tone={detectQuery.data?.found ? 'good' : 'bad'}>{detectQuery.data?.found ? '引擎二进制已找到' : '未找到引擎二进制'}</Badge>{detectQuery.data?.found && <span>{detectQuery.data.path}</span>}{detectQuery.isFetching && <span>检测中…</span>}</p>}
        <p className={page.hint}>预览与 ProcessManager 使用相同的参数语义；保存配置后运行页会使用当前值。</p>
      </Panel>
    </div>
    {browse && (
      <FileBrowser mode={browse.mode} extension={browse.extension} initialPath={browseValue} onClose={() => setBrowse(null)} onSelect={value => { patch(browse.key, value); setBrowse(null) }}/>
    )}
    {importOpen && createPortal(
      <div className={page.overlay} onClick={() => setImportOpen(false)}>
        <Panel className={page.importDialog} title="从启动命令导入" actions={<Button size="small" onClick={() => void pasteFromClipboard()}><ClipboardPaste size={14}/>粘贴</Button>}>
          <Textarea rows={7} className={page.importText} value={importText} autoFocus onChange={event => setImportText(event.target.value)} placeholder={'llama-server -m "E:\\models\\model.gguf" --host 127.0.0.1 --port 8081 -ngl 99 -c 32768 -fa on ...'} />
          <p className={page.hint}>已识别的字段会回填到左侧表单；无法识别的参数会原样放入「附加参数」，不会丢失。</p>
          <div className={page.row} style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            <Button onClick={() => setImportOpen(false)}>取消</Button>
            <Button tone="primary" disabled={!importText.trim()} onClick={importCommand}>解析并应用</Button>
          </div>
        </Panel>
      </div>,
      document.body
    )}
  </>
}

function quote(value: string) { return /\s/.test(value) ? `"${value}"` : value }
function NumberField({ label, value, onChange, step = '1', disabled = false }: { label: string; value: number; onChange: (value: number) => void; step?: string; disabled?: boolean }) {
  return <Field label={label}><Input type="number" step={step} disabled={disabled} value={value} onChange={event => onChange(Number(event.target.value))}/></Field>
}
function OptionalNumber({ label, enabled, value, onEnabled, onChange, step }: { label: string; enabled: boolean; value: number; onEnabled: (value: boolean) => void; onChange: (value: number) => void; step: string }) {
  return <Field label={label}><div className={page.row}><Switch checked={enabled} onChange={onEnabled} label=""/><Input type="number" step={step} disabled={!enabled} value={value} onChange={event => onChange(Number(event.target.value))}/></div></Field>
}
