import { KeyRound, Moon, Plus, RefreshCw, Save, Search, Settings, Sun, Trash2, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { api, uid } from '../api'
import type { Provider, SearchSettings, Theme } from '../types'
import { Button, Field, Input, Select, Switch } from './ui'
import styles from './SettingsDrawer.module.css'

type Tab = 'providers' | 'search' | 'appearance'
const defaults: Record<string, Partial<Provider>> = {
  deepseek: { name: 'DeepSeek', base_url: 'https://api.deepseek.com', default_model: 'deepseek-chat' },
  openai_chat: { name: 'OpenAI Chat', base_url: 'https://api.openai.com/v1', default_model: 'gpt-4.1-mini' },
  openai_responses: { name: 'OpenAI Responses', base_url: 'https://api.openai.com/v1', default_model: 'gpt-4.1-mini' },
  anthropic: { name: 'Anthropic', base_url: 'https://api.anthropic.com/v1', default_model: 'claude-sonnet-4-5' },
  openai_compatible: { name: '兼容 API', base_url: '', default_model: '' },
}

export function SettingsDrawer({ open, onClose, theme, setTheme, onProvidersChanged, toast }: { open: boolean; onClose: () => void; theme: Theme; setTheme: (theme: Theme) => void; onProvidersChanged: () => void; toast: (text: string) => void }) {
  const [tab, setTab] = useState<Tab>('providers')
  const [providers, setProviders] = useState<Provider[]>([])
  const [selectedId, setSelectedId] = useState('deepseek')
  const [draft, setDraft] = useState<Provider | null>(null)
  const [search, setSearch] = useState<SearchSettings | null>(null)
  const load = async () => {
    const result = await api<{ providers: Provider[] }>('/api/chat/providers')
    const items = result.providers.filter(provider => provider.id !== 'local')
    setProviders(items); const selected = items.find(provider => provider.id === selectedId) || items[0]; if (selected) { setSelectedId(selected.id); setDraft({ ...selected }) }
    setSearch(await api<SearchSettings>('/api/search/settings'))
  }
  useEffect(() => { if (open) void load() }, [open])
  const select = (provider: Provider) => { setSelectedId(provider.id); setDraft({ ...provider }) }
  const create = () => { const id = uid('provider').slice(0, 20); const value: Provider = { id, kind: 'openai_compatible', name: '兼容 API', base_url: '', default_model: '', models: [], enabled: true }; setSelectedId(id); setDraft(value) }
  const changeKind = (kind: Provider['kind']) => { if (!draft || kind === 'local') return; setDraft({ ...draft, kind, ...defaults[kind] }) }
  const save = async () => { if (!draft) return; const saved = await api<Provider>('/api/chat/providers', { method: 'POST', body: JSON.stringify(draft) }); toast('厂商配置已保存'); setSelectedId(saved.id); await load(); onProvidersChanged() }
  const remove = async () => { if (!draft || draft.id === 'deepseek') return toast('默认 DeepSeek 不能删除'); await api(`/api/chat/providers/${encodeURIComponent(draft.id)}`, { method: 'DELETE' }); toast('厂商已删除'); setSelectedId('deepseek'); await load(); onProvidersChanged() }
  const fetchModels = async () => { if (!draft) return; await save(); const result = await api<Provider>(`/api/chat/providers/${encodeURIComponent(draft.id)}/models`, { method: 'POST' }); setDraft({ ...result }); toast(`已拉取 ${result.models?.length || 0} 个模型`); onProvidersChanged() }
  const updateSearch = async (provider: 'tavily' | 'brave') => { const result = await api<SearchSettings>('/api/search/settings', { method: 'PUT', body: JSON.stringify({ provider }) }); setSearch(result); toast(`搜索厂商已切换为 ${provider === 'tavily' ? 'Tavily' : 'Brave'}`) }

  return <AnimatePresence>{open && <motion.div className={styles.backdrop} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <motion.aside className={styles.drawer} initial={{ x: 80, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 80, opacity: 0 }} transition={{ type: 'spring', stiffness: 360, damping: 34 }}>
      <header className={styles.header}><Settings size={18}/><strong>设置</strong><Button className={styles.close} iconOnly title="关闭" onClick={onClose}><X size={16}/></Button></header>
      <nav className={styles.tabs}>{([['providers', '模型厂商'], ['search', 'Web Search'], ['appearance', '外观']] as const).map(([id, label]) => <button key={id} className={`${styles.tab} ${tab === id ? styles.active : ''}`} onClick={() => setTab(id)}>{label}</button>)}</nav>
      <div className={styles.content}>
        {tab === 'providers' && <div className={styles.providers}>
          <div className={styles.providerList}>{providers.map(provider => <button key={provider.id} className={`${styles.providerItem} ${selectedId === provider.id ? styles.providerActive : ''}`} onClick={() => select(provider)}><span>{provider.name}</span><small>{provider.kind} · {provider.api_key_set ? '已配置' : '缺少 Key'}</small></button>)}<Button size="small" onClick={create}><Plus size={14}/>新增</Button></div>
          {draft && <div className={styles.form}>
            <div className={styles.grid}><Field label="名称"><Input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/></Field><Field label="类型"><Select value={draft.kind} onChange={event => changeKind(event.target.value as Provider['kind'])}><option value="deepseek">DeepSeek</option><option value="openai_chat">OpenAI Chat</option><option value="openai_responses">OpenAI Responses</option><option value="anthropic">Anthropic</option><option value="openai_compatible">兼容 API</option></Select></Field><Field label="Base URL" className={styles.wide}><Input value={draft.base_url || ''} onChange={event => setDraft({ ...draft, base_url: event.target.value })}/></Field><Field label="默认模型"><Input value={draft.default_model || ''} onChange={event => setDraft({ ...draft, default_model: event.target.value, models: [...new Set([event.target.value, ...(draft.models || [])].filter(Boolean))] })}/></Field><Field label="启用"><Switch checked={draft.enabled !== false} onChange={enabled => setDraft({ ...draft, enabled })} label="允许对话"/></Field></div>
            <div className={styles.status}><KeyRound size={14}/> {draft.migration_error || (draft.api_key_set ? `已通过 ${draft.api_key_env} 配置` : `请在 ~/llama-manager/.env 中设置 ${draft.api_key_env || '对应环境变量'}`)}</div>
            <div><Button tone="primary" onClick={() => void save()}><Save size={14}/>保存</Button> <Button onClick={() => void fetchModels()}><RefreshCw size={14}/>拉取模型</Button> <Button tone="danger" onClick={() => void remove()}><Trash2 size={14}/>删除</Button></div>
          </div>}
        </div>}
        {tab === 'search' && search && <div className={styles.searchChoice}><p>选择模型调用 <code>web_search</code> 时使用的搜索 API。失败会直接返回，不会自动切换厂商。</p>{search.providers.map(provider => <label key={provider.id} className={styles.searchCard} data-active={search.provider === provider.id}><input type="radio" checked={search.provider === provider.id} onChange={() => void updateSearch(provider.id)}/><Search size={18}/><div><strong>{provider.name}</strong><span>{provider.configured ? `已配置 · ${provider.env_var}` : `未配置 · 需要 ${provider.env_var}`}</span></div></label>)}</div>}
        {tab === 'appearance' && <div><p>仅保留浅色和深色两套液态玻璃主题。</p><div className={styles.themeGrid}><button className={styles.themeCard} data-theme-option="light" data-active={theme === 'light'} onClick={() => setTheme('light')}><Sun size={20}/><strong>浅色</strong></button><button className={styles.themeCard} data-theme-option="dark" data-active={theme === 'dark'} onClick={() => setTheme('dark')}><Moon size={20}/><strong>深色</strong></button></div></div>}
      </div>
    </motion.aside>
  </motion.div>}</AnimatePresence>
}
