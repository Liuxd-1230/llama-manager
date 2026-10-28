import { VisualPreferences } from './VisualPreferences'
import { useMotionPreference } from '../hooks/useMotionPreference'
import { KeyRound, Moon, Plus, RefreshCw, Save, Search, Settings, Sun, Trash2, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalFocus } from './Modal'
import { api, uid } from '../api'
import type { Accent, Provider, SearchSettings, Theme } from '../types'
import type { AppSettings } from '../features/studio/types'
import { Button, ConfirmButton, Field, Input, Select, Switch } from './ui'
import styles from './SettingsDrawer.module.css'

type Tab = 'providers' | 'search' | 'appearance' | 'studio'
const KIND_ZH: Record<string, string> = { openai_chat: 'OpenAI Chat', openai_responses: 'OpenAI Responses', anthropic: 'Anthropic 官方' }
const defaults: Record<string, Partial<Provider>> = {
  openai_chat: { name: 'OpenAI Chat', base_url: 'https://api.openai.com/v1', default_model: 'gpt-4.1-mini' },
  openai_responses: { name: 'OpenAI Responses', base_url: 'https://api.openai.com/v1', default_model: 'gpt-4.1-mini' },
  anthropic: { name: 'Anthropic', base_url: 'https://api.anthropic.com/v1', default_model: 'claude-sonnet-4-5' },
}

export function SettingsDrawer({ open, onClose, tab, onTabChange, theme, setTheme, accent, setAccent, onProvidersChanged, toast }: { open: boolean; onClose: () => void; tab: Tab; onTabChange: (tab: Tab) => void; theme: Theme; setTheme: (theme: Theme) => void; accent: Accent; setAccent: (accent: Accent) => void; onProvidersChanged: () => void; toast: (text: string) => void }) {
  const reducedMotion = useMotionPreference()
  const focusRef = useModalFocus<HTMLElement>(open, onClose)
  const [error, setError] = useState('')
  const attempt = async (operation: () => Promise<unknown>) => { setError(''); try { await operation() } catch (reason) { setError(`操作失败：${reason instanceof Error ? reason.message : String(reason)}。请检查设置后重试。`) } }
  const [activeTab, setActiveTab] = useState<Tab>(tab)
  const setTab = (next: Tab) => { setActiveTab(next); onTabChange(next) }
  useEffect(() => { setActiveTab(tab) }, [tab])
  const [providers, setProviders] = useState<Provider[]>([])
  const [selectedId, setSelectedId] = useState('deepseek')
  const [apiKey, setApiKey] = useState('')
  const [draft, setDraft] = useState<Provider | null>(null)
  const [search, setSearch] = useState<SearchSettings | null>(null)
  const [moss, setMoss] = useState<AppSettings | null>(null)
  const [mossBusy, setMossBusy] = useState('')
  const [mossProbe, setMossProbe] = useState<{ ok: boolean; message: string; stream_ok?: boolean; tools_ok?: boolean; models?: number } | null>(null)
  const loadMoss = async () => { setMoss(await api<AppSettings>('/api/v1/moss/settings')) }
  const saveMoss = async () => {
    if (!moss) return
    const payload: Partial<AppSettings> = { provider_id: moss.provider_id, model: moss.model, vision_model: moss.vision_model, fallback_models: moss.fallback_models, temperature: moss.temperature, agent_protocol: moss.agent_protocol, context_turns: moss.context_turns, prompt_prefix: moss.prompt_prefix, negative_prompt: moss.negative_prompt }
    setMoss(await api<AppSettings>('/api/v1/moss/settings', { method: 'PUT', body: JSON.stringify(payload) }))
    toast('提示词工坊设置已保存')
    window.dispatchEvent(new CustomEvent('moss-settings-changed'))
  }
  const runMossProbe = async (kind: 'test' | 'models') => {
    if (!moss) return
    setMossBusy(kind); setMossProbe(null)
    try {
      const body = { provider_id: moss.provider_id, model: moss.model }
      if (kind === 'test') {
        const result = await api<{ ok: boolean; message: string; stream_ok?: boolean; tools_ok?: boolean }>('/api/v1/moss/settings/test', { method: 'POST', body: JSON.stringify(body) })
        setMossProbe(result)
      } else {
        const result = await api<{ models: string[]; count: number }>('/api/v1/moss/settings/models', { method: 'POST', body: JSON.stringify(body) })
        setMossProbe({ ok: true, message: `已发现 ${result.count} 个模型，尚未测试流式与工具调用`, models: result.count })
        if (moss && result.models.length) setMoss({ ...moss, model: moss.model || result.models[0] })
      }
    } finally { setMossBusy('') }
  }
  const load = async () => {
    const result = await api<{ providers: Provider[] }>('/api/v1/chat/providers')
    const items = result.providers.filter(provider => provider.id !== 'local')
    setProviders(items); const selected = items.find(provider => provider.id === selectedId) || items[0]; if (selected) { setSelectedId(selected.id); setDraft({ ...selected }) }
    setSearch(await api<SearchSettings>('/api/v1/search/settings'))
  }
  useEffect(() => { if (open) { void attempt(load); void loadMoss().catch(() => setMoss(null)) } }, [open])
  const select = (provider: Provider) => { setSelectedId(provider.id); setDraft({ ...provider }); setApiKey('') }
  const create = () => { const id = uid('provider').slice(0, 20); const value: Provider = { id, kind: 'openai_chat', name: '新提供商', base_url: '', default_model: '', models: [], enabled: true }; setProviders(items => [...items, value]); setSelectedId(id); setDraft(value); setApiKey('') }
  const changeKind = (kind: Provider['kind']) => { if (!draft || kind === 'local') return; const previous=defaults[draft.kind] || {}; const next=defaults[kind] || {}; setDraft({ ...draft, kind, name: draft.name === previous.name ? next.name || draft.name : draft.name, base_url: !draft.base_url || draft.base_url === previous.base_url ? next.base_url : draft.base_url, default_model: !draft.default_model || draft.default_model === previous.default_model ? next.default_model || '' : draft.default_model }) }
  const save = async () => { if (!draft) return; const saved = await api<Provider>('/api/v1/chat/providers', { method: 'POST', body: JSON.stringify(draft) }); if (apiKey) { await api(`/api/v1/providers/${saved.id}/secret`, { method: 'PUT', body: JSON.stringify({ key: apiKey }) }); setApiKey('') }; toast('厂商配置已保存'); setSelectedId(saved.id); await load(); onProvidersChanged() }
  const remove = async () => { if (!draft || draft.id === 'deepseek') return toast('默认 DeepSeek 不能删除'); await api(`/api/v1/chat/providers/${encodeURIComponent(draft.id)}`, { method: 'DELETE' }); toast('厂商已删除'); setSelectedId('deepseek'); await load(); onProvidersChanged() }
  const fetchModels = async () => { if (!draft) return; await save(); const result = await api<Provider>(`/api/v1/chat/providers/${encodeURIComponent(draft.id)}/models`, { method: 'POST' }); setDraft({ ...result }); toast(`已拉取 ${result.models?.length || 0} 个模型`); onProvidersChanged() }
  const updateSearch = async (provider: 'tavily' | 'brave') => { const result = await api<SearchSettings>('/api/v1/search/settings', { method: 'PUT', body: JSON.stringify({ provider }) }); setSearch(result); toast(`搜索厂商已切换为 ${provider === 'tavily' ? 'Tavily' : 'Brave'}`) }

  return createPortal(<AnimatePresence>{open && <motion.div className={styles.backdrop} initial={reducedMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: reducedMotion ? 1 : 0 }} transition={reducedMotion ? { duration: 0 } : { duration: .18 }} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <motion.aside ref={focusRef} role="dialog" aria-modal="true" aria-label="设置" tabIndex={-1} className={styles.drawer} initial={reducedMotion ? false : { x: 80, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={reducedMotion ? { x: 0, opacity: 1 } : { x: 80, opacity: 0 }} transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 360, damping: 34 }}>
      <header className={styles.header}><Settings size={18}/><strong>设置</strong><Button className={styles.close} iconOnly title="关闭" onClick={onClose}><X size={16}/></Button></header>
      <nav className={styles.tabs} aria-label="设置分类">{([['providers', '模型服务'], ['search', 'Web Search'], ['studio', 'Agent 与图像'], ['appearance', '外观']] as const).map(([id, label]) => <button key={id} aria-current={activeTab===id?'page':undefined} className={`${styles.tab} ${activeTab === id ? styles.active : ''}`} onClick={() => setTab(id)}>{activeTab===id && <motion.span className={styles.tabSelection} layoutId="atelier-settings-tab" transition={{duration:reducedMotion?0:.2,ease:[.22,1,.36,1]}}/>}<span>{label}</span></button>)}</nav>
      <motion.div key={activeTab} className={styles.content} initial={reducedMotion?false:{x:14,clipPath:'inset(0 0 0 8%)'}} animate={{x:0,clipPath:'inset(0 0 0 0%)'}} transition={{duration:reducedMotion?0:.24,ease:[.22,1,.36,1]}}>{error && <p role="alert" className={styles.status}>{error}</p>}
        {activeTab === 'providers' && <div className={styles.providers}>
          <div className={styles.providerList}>{providers.map(provider => <button key={provider.id} className={`${styles.providerItem} ${selectedId === provider.id ? styles.providerActive : ''}`} onClick={() => select(provider)}><span>{provider.name}</span><small>{KIND_ZH[provider.kind] || provider.kind} · {provider.api_key_set ? '已配置' : '缺少 Key'}</small></button>)}<Button size="small" onClick={create}><Plus size={14}/>新增</Button></div>
          {draft && <div className={styles.form}>
            <div className={styles.grid}><Field label="名称"><Input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/></Field><Field label="类型"><Select value={draft.kind} onChange={event => changeKind(event.target.value as Provider['kind'])}><option value="openai_chat">OpenAI Chat</option><option value="openai_responses">OpenAI Responses</option><option value="anthropic">Anthropic</option></Select></Field><Field label="Base URL" className={styles.wide}><Input value={draft.base_url || ''} onChange={event => setDraft({ ...draft, base_url: event.target.value })}/></Field><Field label="默认模型"><Input value={draft.default_model || ''} onChange={event => setDraft({ ...draft, default_model: event.target.value, models: [...new Set([event.target.value, ...(draft.models || [])].filter(Boolean))] })}/></Field><Field label="启用"><Switch checked={draft.enabled !== false} onChange={enabled => setDraft({ ...draft, enabled })} label="允许对话"/></Field></div>
          <details className={styles.protocolHelp}><summary>协议与密钥说明</summary><p>按服务支持的协议选择。Anthropic 使用 Claude 接口；DeepSeek、LM Studio、vLLM 和多数网关使用 OpenAI Chat；OpenAI Responses 为独立协议。Base URL 必填，不会回落到默认服务。环境变量密钥优先于应用保存的密钥。</p></details>
            <Field label="API Key（加密保存）"><Input type="password" value={apiKey} autoComplete="off" placeholder="留空保留现有密钥" onChange={event => setApiKey(event.target.value)}/></Field>
            <div className={styles.status}><KeyRound size={14}/> {draft.migration_error || (draft.api_key_set ? `密钥已配置 · ${draft.api_key_source === 'dpapi' ? 'Windows 加密存储' : draft.api_key_env}` : `可输入密钥，或设置环境变量 ${draft.api_key_env || '对应环境变量'}`)}</div>
            <div><Button tone="primary" onClick={() => void attempt(save)}><Save size={14}/>保存</Button> <Button onClick={() => void attempt(fetchModels)}><RefreshCw size={14}/>拉取模型</Button> <ConfirmButton tone="danger" confirmLabel="确认删除厂商？" onConfirm={() => void attempt(remove)}><Trash2 size={14}/>删除</ConfirmButton></div>
          </div>}
        </div>}
        {activeTab === 'search' && search && <div className={styles.searchChoice}><p>选择模型调用 <code>web_search</code> 时使用的搜索 API。失败会直接返回，不会自动切换厂商。</p>{search.providers.map(provider => <label key={provider.id} className={styles.searchCard} data-active={search.provider === provider.id}><input type="radio" checked={search.provider === provider.id} onChange={() => void attempt(() => updateSearch(provider.id))}/><Search size={18}/><div><strong>{provider.name}</strong><span>{provider.configured ? `已配置 · ${provider.env_var}` : `未配置 · 需要 ${provider.env_var}`}</span></div></label>)}</div>}
        {activeTab === 'appearance' && <div>
          <VisualPreferences/>
          <p><a href="#/about" onClick={onClose}>关于 Atelier · 标志构造</a></p>
          <div className={styles.themeGrid}><button className={styles.themeCard} data-theme-option="light" data-active={theme === 'light'} onClick={() => setTheme('light')}><Sun size={20}/><strong>浅色</strong></button><button className={styles.themeCard} data-theme-option="dark" data-active={theme === 'dark'} onClick={() => setTheme('dark')}><Moon size={20}/><strong>深色</strong></button></div>
          <p style={{ marginTop: 14, marginBottom: 8, color: 'var(--text-3)', fontSize: 12 }}>强调色</p>
          <div style={{ display: 'flex', gap: 10 }}>
            {([['coral', 'var(--swatch-coral)', '陶土'], ['violet', 'var(--swatch-violet)', '紫罗兰'], ['ocean', 'var(--swatch-ocean)', '海洋'], ['amber', 'var(--swatch-amber)', '琥珀']] as const).map(([value, color, label]) => (
              <button key={value} onClick={() => setAccent(value)} title={label}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 10,
                  border: `1px solid ${accent === value ? 'var(--accent)' : 'var(--line)'}`, background: accent === value ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', color: 'var(--text-2)', fontSize: 11 }}>
                <span style={{ width: 22, height: 22, borderRadius: '50%', background: color, outline: accent === value ? `2px solid var(--accent)` : 'none', outlineOffset: 3 }}/>
                {label}
              </button>
            ))}
          </div>
        </div>}
        {activeTab === 'studio' && moss && <div>
          <p>Agent 与对话共享模型服务。本地引擎需先启动，无需 API Key。</p>
          <div className={styles.grid}>
            <Field label="提供商"><Select value={moss.provider_id} onChange={event => setMoss({ ...moss, provider_id: event.target.value })}>{(moss.providers || []).map(p => <option key={p.id} value={p.id}>{p.name}{p.enabled ? '' : '（已停用）'}</option>)}</Select></Field>
            <Field label="主模型"><Input value={moss.model} onChange={event => setMoss({ ...moss, model: event.target.value })}/></Field>
            <Field label="视觉模型（图像反推）"><Input value={moss.vision_model} onChange={event => setMoss({ ...moss, vision_model: event.target.value })}/></Field>
            <Field label="后备模型（逗号分隔）"><Input value={moss.fallback_models} onChange={event => setMoss({ ...moss, fallback_models: event.target.value })}/></Field>
            <Field label="工具协议"><Select value={moss.agent_protocol} onChange={event => setMoss({ ...moss, agent_protocol: event.target.value as AppSettings['agent_protocol'] })}><option value="auto">自动</option><option value="tools">函数调用</option><option value="tags">标签协议</option></Select></Field>
            <Field label={`温度 ${moss.temperature ?? 0.7}`}><Input type="range" min={0} max={2} step={0.05} value={moss.temperature ?? 0.7} onChange={event => setMoss({ ...moss, temperature: Number(event.target.value) })}/></Field>
            <Field label={`记忆轮数 ${moss.context_turns ?? 10}`}><Input type="range" min={2} max={40} step={1} value={moss.context_turns ?? 10} onChange={event => setMoss({ ...moss, context_turns: Number(event.target.value) })}/></Field>
            <Field label="质量前缀（复制时可选附加）"><Input value={moss.prompt_prefix ?? ''} onChange={event => setMoss({ ...moss, prompt_prefix: event.target.value })}/></Field>
            <Field label="负面提示词" className={styles.wide}><Input value={moss.negative_prompt ?? ''} onChange={event => setMoss({ ...moss, negative_prompt: event.target.value })}/></Field>
          </div>
          <div style={{ display: 'flex', gap: 8, margin: '12px 0 0', flexWrap: 'wrap' }}>
            <Button size="small" onClick={() => void attempt(() => runMossProbe('test'))}>{mossBusy === 'test' ? '测试中…' : '测试连接'}</Button>
            <Button size="small" onClick={() => void attempt(() => runMossProbe('models'))}>{mossBusy === 'models' ? '拉取中…' : '拉取模型列表'}</Button>
            {mossProbe && <span style={{ alignSelf: 'center', color: mossProbe.ok ? 'var(--green)' : 'var(--red)', fontSize: 12 }}>{mossProbe.models !== undefined ? mossProbe.message : mossProbe.ok ? `可用（流式${mossProbe.stream_ok ? '✓' : '✗'} / 函数调用${mossProbe.tools_ok ? '✓' : '✗'}${mossProbe.models ? ` / ${mossProbe.models} 个模型` : ''}）` : mossProbe.message}</span>}
          </div>
          <p style={{ margin: '10px 0 0', color: 'var(--text-3)', fontSize: 12, lineHeight: 1.7 }}>密钥沿用各厂商在「模型厂商」页签里配置的环境变量（本地引擎除外，它直接使用已加载的模型）。</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}><Button tone="primary" onClick={() => void attempt(saveMoss)}><Save size={14}/>保存工坊设置</Button></div>
        </div>}
      </motion.div>
    </motion.aside>
  </motion.div>}</AnimatePresence>, document.body)
}
