import { KeyRound, Moon, Plus, RefreshCw, Save, Search, Settings, Sun, Trash2, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalFocus } from './Modal'
import { api, uid } from '../api'
import type { Accent, Provider, SearchSettings, Theme } from '../types'
import type { AppSettings } from '../features/studio/types'
import { Button, ConfirmButton, Field, Input, Select, Switch } from './ui'
import styles from './SettingsDrawer.module.css'

type Tab = 'providers' | 'search' | 'appearance' | 'studio'
const KIND_ZH: Record<string, string> = { openai_chat: 'OpenAI Chat', openai_responses: 'OpenAI Responses', anthropic: 'Anthropic 官方', openai_compatible: 'OpenAI 兼容' }
const defaults: Record<string, Partial<Provider>> = {
  openai_chat: { name: 'OpenAI Chat', base_url: 'https://api.openai.com/v1', default_model: 'gpt-4.1-mini' },
  openai_responses: { name: 'OpenAI Responses', base_url: 'https://api.openai.com/v1', default_model: 'gpt-4.1-mini' },
  anthropic: { name: 'Anthropic', base_url: 'https://api.anthropic.com/v1', default_model: 'claude-sonnet-4-5' },
  openai_compatible: { name: '兼容 API', base_url: '', default_model: '' },
}

export function SettingsDrawer({ open, onClose, theme, setTheme, accent, setAccent, onProvidersChanged, toast }: { open: boolean; onClose: () => void; theme: Theme; setTheme: (theme: Theme) => void; accent: Accent; setAccent: (accent: Accent) => void; onProvidersChanged: () => void; toast: (text: string) => void }) {
  const reducedMotion = useReducedMotion()
  const focusRef = useModalFocus<HTMLElement>(open, onClose)
  const [error, setError] = useState('')
  const attempt = async (operation: () => Promise<unknown>) => { setError(''); try { await operation() } catch (reason) { setError(`操作失败：${reason instanceof Error ? reason.message : String(reason)}。请检查设置后重试。`) } }
  const [tab, setTab] = useState<Tab>('providers')
  const [providers, setProviders] = useState<Provider[]>([])
  const [selectedId, setSelectedId] = useState('deepseek')
  const [draft, setDraft] = useState<Provider | null>(null)
  const [search, setSearch] = useState<SearchSettings | null>(null)
  const [moss, setMoss] = useState<AppSettings | null>(null)
  const loadMoss = async () => { setMoss(await api<AppSettings>('/api/moss/settings')) }
  const saveMoss = async () => {
    if (!moss) return
    const payload: Partial<AppSettings> = { provider_id: moss.provider_id, model: moss.model, vision_model: moss.vision_model, fallback_models: moss.fallback_models, temperature: moss.temperature, agent_protocol: moss.agent_protocol, context_turns: moss.context_turns }
    setMoss(await api<AppSettings>('/api/moss/settings', { method: 'PUT', body: JSON.stringify(payload) }))
    toast('提示词工坊设置已保存')
  }
  const load = async () => {
    const result = await api<{ providers: Provider[] }>('/api/chat/providers')
    const items = result.providers.filter(provider => provider.id !== 'local')
    setProviders(items); const selected = items.find(provider => provider.id === selectedId) || items[0]; if (selected) { setSelectedId(selected.id); setDraft({ ...selected }) }
    setSearch(await api<SearchSettings>('/api/search/settings'))
  }
  useEffect(() => { if (open) { void attempt(load); void loadMoss().catch(() => setMoss(null)) } }, [open])
  const select = (provider: Provider) => { setSelectedId(provider.id); setDraft({ ...provider }) }
  const create = () => { const id = uid('provider').slice(0, 20); const value: Provider = { id, kind: 'openai_compatible', name: '兼容 API', base_url: '', default_model: '', models: [], enabled: true }; setProviders(items => [...items, value]); setSelectedId(id); setDraft(value) }
  const changeKind = (kind: Provider['kind']) => { if (!draft || kind === 'local') return; setDraft({ ...draft, kind, ...defaults[kind] }) }
  const save = async () => { if (!draft) return; const saved = await api<Provider>('/api/chat/providers', { method: 'POST', body: JSON.stringify(draft) }); toast('厂商配置已保存'); setSelectedId(saved.id); await load(); onProvidersChanged() }
  const remove = async () => { if (!draft || draft.id === 'deepseek') return toast('默认 DeepSeek 不能删除'); await api(`/api/chat/providers/${encodeURIComponent(draft.id)}`, { method: 'DELETE' }); toast('厂商已删除'); setSelectedId('deepseek'); await load(); onProvidersChanged() }
  const fetchModels = async () => { if (!draft) return; await save(); const result = await api<Provider>(`/api/chat/providers/${encodeURIComponent(draft.id)}/models`, { method: 'POST' }); setDraft({ ...result }); toast(`已拉取 ${result.models?.length || 0} 个模型`); onProvidersChanged() }
  const updateSearch = async (provider: 'tavily' | 'brave') => { const result = await api<SearchSettings>('/api/search/settings', { method: 'PUT', body: JSON.stringify({ provider }) }); setSearch(result); toast(`搜索厂商已切换为 ${provider === 'tavily' ? 'Tavily' : 'Brave'}`) }

  return createPortal(<AnimatePresence>{open && <motion.div className={styles.backdrop} initial={reducedMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: reducedMotion ? 1 : 0 }} transition={reducedMotion ? { duration: 0 } : { duration: .18 }} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <motion.aside ref={focusRef} role="dialog" aria-modal="true" aria-label="设置" tabIndex={-1} className={styles.drawer} initial={reducedMotion ? false : { x: 80, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={reducedMotion ? { x: 0, opacity: 1 } : { x: 80, opacity: 0 }} transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 360, damping: 34 }}>
      <header className={styles.header}><Settings size={18}/><strong>设置</strong><Button className={styles.close} iconOnly title="关闭" onClick={onClose}><X size={16}/></Button></header>
      <nav className={styles.tabs}>{([['providers', '模型厂商'], ['search', 'Web Search'], ['studio', '提示词工坊'], ['appearance', '外观']] as const).map(([id, label]) => <button key={id} className={`${styles.tab} ${tab === id ? styles.active : ''}`} onClick={() => setTab(id)}>{label}</button>)}</nav>
      <div className={styles.content}>{error && <p role="alert" className={styles.status}>{error}</p>}
        {tab === 'providers' && <div className={styles.providers}>
          <div className={styles.providerList}>{providers.map(provider => <button key={provider.id} className={`${styles.providerItem} ${selectedId === provider.id ? styles.providerActive : ''}`} onClick={() => select(provider)}><span>{provider.name}</span><small>{KIND_ZH[provider.kind] || provider.kind} · {provider.api_key_set ? '已配置' : '缺少 Key'}</small></button>)}<Button size="small" onClick={create}><Plus size={14}/>新增</Button></div>
          {draft && <div className={styles.form}>
            <div className={styles.grid}><Field label="名称"><Input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/></Field><Field label="类型"><Select value={draft.kind} onChange={event => changeKind(event.target.value as Provider['kind'])}><option value="openai_chat">OpenAI Chat</option><option value="openai_responses">OpenAI Responses</option><option value="anthropic">Anthropic</option><option value="openai_compatible">OpenAI 兼容</option></Select></Field><Field label="Base URL" className={styles.wide}><Input value={draft.base_url || ''} onChange={event => setDraft({ ...draft, base_url: event.target.value })}/></Field><Field label="默认模型"><Input value={draft.default_model || ''} onChange={event => setDraft({ ...draft, default_model: event.target.value, models: [...new Set([event.target.value, ...(draft.models || [])].filter(Boolean))] })}/></Field><Field label="启用"><Switch checked={draft.enabled !== false} onChange={enabled => setDraft({ ...draft, enabled })} label="允许对话"/></Field></div>
          <p style={{ margin: '10px 0 0', color: 'var(--text-3)', fontSize: 12, lineHeight: 1.7 }}>协议即接口规范：DeepSeek / Anthropic 走各自官方接口；OpenAI Chat 覆盖绝大多数 OpenAI 兼容服务（含本地引擎代理）；「兼容 API」用于任意自定义 OpenAI 兼容地址。密钥通过上方提示的环境变量配置，写入 ~/llama-manager/.env。</p>
            <div className={styles.status}><KeyRound size={14}/> {draft.migration_error || (draft.api_key_set ? `已通过 ${draft.api_key_env} 配置` : `请在 ~/llama-manager/.env 中设置 ${draft.api_key_env || '对应环境变量'}`)}</div>
            <div><Button tone="primary" onClick={() => void attempt(save)}><Save size={14}/>保存</Button> <Button onClick={() => void attempt(fetchModels)}><RefreshCw size={14}/>拉取模型</Button> <ConfirmButton tone="danger" confirmLabel="确认删除厂商？" onConfirm={() => void attempt(remove)}><Trash2 size={14}/>删除</ConfirmButton></div>
          </div>}
        </div>}
        {tab === 'search' && search && <div className={styles.searchChoice}><p>选择模型调用 <code>web_search</code> 时使用的搜索 API。失败会直接返回，不会自动切换厂商。</p>{search.providers.map(provider => <label key={provider.id} className={styles.searchCard} data-active={search.provider === provider.id}><input type="radio" checked={search.provider === provider.id} onChange={() => void attempt(() => updateSearch(provider.id))}/><Search size={18}/><div><strong>{provider.name}</strong><span>{provider.configured ? `已配置 · ${provider.env_var}` : `未配置 · 需要 ${provider.env_var}`}</span></div></label>)}</div>}
        {tab === 'appearance' && <div>
          <p>暖纸主题与强调色。强调色影响按钮、选中态与高亮。</p>
          <div className={styles.themeGrid}><button className={styles.themeCard} data-theme-option="light" data-active={theme === 'light'} onClick={() => setTheme('light')}><Sun size={20}/><strong>浅色</strong></button><button className={styles.themeCard} data-theme-option="dark" data-active={theme === 'dark'} onClick={() => setTheme('dark')}><Moon size={20}/><strong>深色</strong></button></div>
          <p style={{ marginTop: 14, marginBottom: 8, color: 'var(--text-3)', fontSize: 12 }}>强调色</p>
          <div style={{ display: 'flex', gap: 10 }}>
            {([['coral', '#ee6266', '珊瑚'], ['violet', '#8a5cf6', '紫罗兰'], ['ocean', '#3578e5', '海洋'], ['amber', '#e08a3c', '琥珀']] as const).map(([value, color, label]) => (
              <button key={value} onClick={() => setAccent(value)} title={label}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 10,
                  border: `1px solid ${accent === value ? 'var(--accent)' : 'var(--line)'}`, background: accent === value ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', color: 'var(--text-2)', fontSize: 11 }}>
                <span style={{ width: 22, height: 22, borderRadius: '50%', background: color, boxShadow: accent === value ? `0 0 0 3px ${color}44` : 'none' }}/>
                {label}
              </button>
            ))}
          </div>
        </div>}
        {tab === 'studio' && moss && <div>
          <p>提示词工坊（画框编排 / 镜头 / 灯光）的 Agent 使用以下模型设置，与对话页共享同一批厂商。</p>
          <div className={styles.grid}>
            <Field label="提供商"><Select value={moss.provider_id} onChange={event => setMoss({ ...moss, provider_id: event.target.value })}>{(moss.providers || []).map(p => <option key={p.id} value={p.id}>{p.name}{p.enabled ? '' : '（已停用）'}</option>)}</Select></Field>
            <Field label="主模型"><Input value={moss.model} onChange={event => setMoss({ ...moss, model: event.target.value })}/></Field>
            <Field label="视觉模型（图像反推）"><Input value={moss.vision_model} onChange={event => setMoss({ ...moss, vision_model: event.target.value })}/></Field>
            <Field label="后备模型（逗号分隔）"><Input value={moss.fallback_models} onChange={event => setMoss({ ...moss, fallback_models: event.target.value })}/></Field>
            <Field label="工具协议"><Select value={moss.agent_protocol} onChange={event => setMoss({ ...moss, agent_protocol: event.target.value as AppSettings['agent_protocol'] })}><option value="auto">自动</option><option value="tools">函数调用</option><option value="tags">标签协议</option></Select></Field>
            <Field label={`温度 ${moss.temperature ?? 0.7}`}><Input type="range" min={0} max={2} step={0.05} value={moss.temperature ?? 0.7} onChange={event => setMoss({ ...moss, temperature: Number(event.target.value) })}/></Field>
          </div>
          <p style={{ margin: '10px 0 0', color: 'var(--text-3)', fontSize: 12, lineHeight: 1.7 }}>密钥沿用各厂商在「模型厂商」页签里配置的环境变量；工坊内的「设置」弹窗与本页读写同一份数据。</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}><Button tone="primary" onClick={() => void attempt(saveMoss)}><Save size={14}/>保存工坊设置</Button></div>
        </div>}
      </div>
    </motion.aside>
  </motion.div>}</AnimatePresence>, document.body)
}
