import { Copy, Download, FolderOpen, RefreshCw, Save, Trash2, Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { FileBrowser } from '../../components/FileBrowser'
import { Button, Field, Input, Panel, Select, Switch, Textarea } from '../../components/ui'
import type { AppConfig } from '../../types'
import page from '../pages.module.css'

type BrowseTarget = { key: 'llama_cpp_dir' | 'model_path' | 'mmproj_path'; mode: 'folder' | 'file'; extension?: string } | null

export function ConfigPage({ config, setConfig, toast }: { config: AppConfig; setConfig: (config: AppConfig) => void; toast: (text: string) => void }) {
  const [name, setName] = useState('default')
  const [configs, setConfigs] = useState<string[]>([])
  const [browse, setBrowse] = useState<BrowseTarget>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const basic = config.basic
  const sampling = config.sampling
  const mtp = config.mtp

  const patch = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => setConfig({ ...config, [key]: value })
  const patchBasic = (value: Partial<AppConfig['basic']>) => patch('basic', { ...basic, ...value })
  const patchSampling = (value: Partial<AppConfig['sampling']>) => patch('sampling', { ...sampling, ...value })
  const patchMtp = (value: Partial<AppConfig['mtp']>) => patch('mtp', { ...mtp, ...value })
  const refreshNames = async () => {
    try { setConfigs((await api<{ configs: string[] }>('/api/config/list')).configs || []) } catch { setConfigs([]) }
  }
  useEffect(() => { void refreshNames() }, [])

  const save = async () => {
    await api('/api/config/save-as', { method: 'POST', body: JSON.stringify({ name: name || 'default', config }) })
    toast(`配置已保存：${name || 'default'}`); await refreshNames()
  }
  const load = async (selected: string) => {
    if (!selected) return
    setConfig(await api<AppConfig>('/api/config/load', { method: 'POST', body: JSON.stringify({ name: selected }) }))
    setName(selected); toast(`已载入：${selected}`)
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

  const command = useMemo(() => {
    const args: string[] = ['llama-server', '-m', quote(config.model_path || '<model.gguf>'), '-c', String(basic.ctx_size)]
    if (basic.fit_enabled) args.push('--fit', 'on', '--fit-target', String(basic.fit_target))
    else args.push('-ngl', String(basic.ngl_enabled ? basic.ngl : 0))
    args.push('-t', String(basic.threads), '-np', String(basic.parallel), basic.mmap ? '--mmap' : '--no-mmap')
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
    if (mtp.enabled) args.push('--spec-type', mtp.spec_type, '--spec-draft-n-max', String(mtp.draft_n_max))
    args.push('--host', config.server.host, '--port', String(config.server.port))
    if (config.extra_params.trim()) args.push(config.extra_params.trim())
    return args.join(' ')
  }, [config, basic, sampling, mtp])

  const browseValue = browse ? config[browse.key] : ''

  return <>
    <div className={page.splitMain}>
      <div className={page.stack}>
        <Panel title="配置文件" actions={<div className={page.row}><Button size="small" onClick={exportConfig}><Upload size={14}/>导出</Button><Button size="small" onClick={() => importRef.current?.click()}><Download size={14}/>导入</Button></div>}>
          <div className={page.formGridThree}>
            <Field label="配置名称"><Input value={name} onChange={event => setName(event.target.value)} /></Field>
            <Field label="已保存配置"><Select value={configs.includes(name) ? name : ''} onChange={event => void load(event.target.value)}><option value="">选择配置</option>{configs.map(item => <option key={item}>{item}</option>)}</Select></Field>
            <div className={page.row} style={{ alignSelf: 'end' }}><Button tone="primary" onClick={() => void save()}><Save size={15}/>保存</Button><Button tone="danger" onClick={() => void remove()}><Trash2 size={15}/>删除</Button></div>
          </div>
          <input ref={importRef} hidden type="file" accept=".json" onChange={event => void importConfig(event.target.files?.[0])} />
        </Panel>

        <Panel title="模型与运行目录">
          <div className={page.formGrid}>
            <Field label="llama.cpp 目录"><div className={page.row}><Input value={config.llama_cpp_dir} onChange={event => patch('llama_cpp_dir', event.target.value)} /><Button iconOnly title="浏览" onClick={() => setBrowse({ key: 'llama_cpp_dir', mode: 'folder' })}><FolderOpen size={16}/></Button></div></Field>
            <Field label="GGUF 模型"><div className={page.row}><Input value={config.model_path} onChange={event => patch('model_path', event.target.value)} /><Button iconOnly title="浏览" onClick={() => setBrowse({ key: 'model_path', mode: 'file', extension: '.gguf' })}><FolderOpen size={16}/></Button></div></Field>
            <Field label="MMProj"><div className={page.row}><Input value={config.mmproj_path} onChange={event => patch('mmproj_path', event.target.value)} /><Button iconOnly title="浏览" onClick={() => setBrowse({ key: 'mmproj_path', mode: 'file', extension: '.gguf' })}><FolderOpen size={16}/></Button></div></Field>
            <Field label="监听模式"><Select value={config.server.mode} onChange={event => patch('server', { ...config.server, mode: event.target.value, host: event.target.value === 'lan' ? '0.0.0.0' : '127.0.0.1' })}><option value="local">本地 127.0.0.1</option><option value="lan">局域网 0.0.0.0</option></Select></Field>
            <Field label="监听地址"><Input value={config.server.host} onChange={event => patch('server', { ...config.server, host: event.target.value })} /></Field>
            <Field label="端口"><Input type="number" value={config.server.port} onChange={event => patch('server', { ...config.server, port: Number(event.target.value) })} /></Field>
          </div>
        </Panel>

        <Panel title="推理与显存">
          <div className={page.formGridThree}>
            <NumberField label="上下文" value={basic.ctx_size} onChange={ctx_size => patchBasic({ ctx_size })} />
            <NumberField label="CPU 线程" value={basic.threads} onChange={threads => patchBasic({ threads })} />
            <NumberField label="并行数" value={basic.parallel} onChange={parallel => patchBasic({ parallel })} />
            <Field label="GPU 卸载"><div className={page.row}><Switch checked={basic.ngl_enabled} disabled={basic.fit_enabled} onChange={ngl_enabled => patchBasic({ ngl_enabled })} label="NGL"/><Input type="number" disabled={!basic.ngl_enabled || basic.fit_enabled} value={basic.ngl} onChange={event => patchBasic({ ngl: Number(event.target.value) })}/></div></Field>
            <Field label="自动适配 GPU"><div className={page.row}><Switch checked={basic.fit_enabled} onChange={fit_enabled => patchBasic({ fit_enabled })} label="Fit"/><Input type="number" disabled={!basic.fit_enabled} value={basic.fit_target} onChange={event => patchBasic({ fit_target: Number(event.target.value) })}/></div></Field>
            <NumberField label="MoE CPU 层" value={basic.n_cpu_moe} onChange={n_cpu_moe => patchBasic({ n_cpu_moe })} />
            <Field label="KV Cache K"><Select value={basic.kv_cache_quant_k} onChange={event => patchBasic({ kv_cache_quant_k: event.target.value })}><option value="">默认</option><option>q8_0</option><option>q4_0</option></Select></Field>
            <Field label="KV Cache V"><Select value={basic.kv_cache_quant_v} onChange={event => patchBasic({ kv_cache_quant_v: event.target.value })}><option value="">默认</option><option>q8_0</option><option>q4_0</option></Select></Field>
            <NumberField label="Cache RAM MiB" value={basic.cache_ram} onChange={cache_ram => patchBasic({ cache_ram })} />
          </div>
          <div className={page.wrap} style={{ marginTop: 14 }}>
            <Switch checked={basic.mmap} onChange={mmap => patchBasic({ mmap })} label="MMap"/><Switch checked={basic.mlock} onChange={mlock => patchBasic({ mlock })} label="MLock"/>
            <Switch checked={basic.kv_offload} onChange={kv_offload => patchBasic({ kv_offload })} label="KV GPU"/><Switch checked={basic.flash_attn} onChange={flash_attn => patchBasic({ flash_attn })} label="Flash Attention"/>
            <Switch checked={basic.kv_unified} onChange={kv_unified => patchBasic({ kv_unified })} label="Unified KV"/><Switch checked={basic.context_shift} onChange={context_shift => patchBasic({ context_shift })} label="Context Shift"/>
            <Switch checked={basic.enable_thinking} onChange={enable_thinking => patchBasic({ enable_thinking })} label="Reasoning"/>
          </div>
          <div className={page.formGrid} style={{ marginTop: 12 }}><NumberField label="Batch" value={basic.batch_size} onChange={batch_size => patchBasic({ batch_size })}/><NumberField label="Micro Batch" value={basic.ubatch_size} onChange={ubatch_size => patchBasic({ ubatch_size })}/></div>
        </Panel>

        <Panel title="采样与 MTP">
          <div className={page.formGridThree}>
            <NumberField label="温度" value={sampling.temperature} step="0.05" onChange={temperature => patchSampling({ temperature })}/>
            <NumberField label="Top-K" value={sampling.top_k} onChange={top_k => patchSampling({ top_k })}/>
            <NumberField label="Top-P" value={sampling.top_p} step="0.01" onChange={top_p => patchSampling({ top_p })}/>
            <OptionalNumber label="Min-P" enabled={sampling.min_p_enabled} value={sampling.min_p} step="0.01" onEnabled={min_p_enabled => patchSampling({ min_p_enabled })} onChange={min_p => patchSampling({ min_p })}/>
            <OptionalNumber label="重复惩罚" enabled={sampling.repeat_penalty_enabled} value={sampling.repeat_penalty} step="0.05" onEnabled={repeat_penalty_enabled => patchSampling({ repeat_penalty_enabled })} onChange={repeat_penalty => patchSampling({ repeat_penalty })}/>
            <OptionalNumber label="存在惩罚" enabled={sampling.presence_penalty_enabled} value={sampling.presence_penalty} step="0.1" onEnabled={presence_penalty_enabled => patchSampling({ presence_penalty_enabled })} onChange={presence_penalty => patchSampling({ presence_penalty })}/>
          </div>
          <div className={page.formGridThree} style={{ marginTop: 14 }}>
            <Field label="MTP"><Switch checked={mtp.enabled} onChange={enabled => patchMtp({ enabled })} label="启用投机解码"/></Field>
            <NumberField label="最大草稿 Token" value={mtp.draft_n_max} disabled={!mtp.enabled} onChange={draft_n_max => patchMtp({ draft_n_max })}/>
            <NumberField label="最小草稿 Token" value={mtp.draft_n_min} disabled={!mtp.enabled} onChange={draft_n_min => patchMtp({ draft_n_min })}/>
            <NumberField label="P Min" value={mtp.p_min} step="0.01" disabled={!mtp.enabled} onChange={p_min => patchMtp({ p_min })}/>
            <NumberField label="P Split" value={mtp.p_split} step="0.01" disabled={!mtp.enabled} onChange={p_split => patchMtp({ p_split })}/>
          </div>
        </Panel>

        <Panel title="提示词与附加参数">
          <div className={page.formGrid}><Field label="系统提示词"><Textarea value={config.system_prompt} onChange={event => patch('system_prompt', event.target.value)}/></Field><Field label="附加参数"><Textarea value={config.extra_params} onChange={event => patch('extra_params', event.target.value)}/></Field><Field label="编译命令" className={page.wide}><Textarea value={config.compile.command} onChange={event => patch('compile', { command: event.target.value })}/></Field></div>
        </Panel>
      </div>

      <Panel title="启动命令" icon={<RefreshCw size={15}/>} className={page.sticky} actions={<Button size="small" onClick={() => { void navigator.clipboard.writeText(command); toast('命令已复制') }}><Copy size={14}/>复制</Button>}>
        <pre className={page.code}>{command}</pre>
        <p className={page.hint}>预览与 ProcessManager 使用相同的参数语义；保存配置后运行页会使用当前值。</p>
      </Panel>
    </div>
    {browse && (
      <FileBrowser mode={browse.mode} extension={browse.extension} initialPath={browseValue} onClose={() => setBrowse(null)} onSelect={value => { patch(browse.key, value); setBrowse(null) }}/>
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
