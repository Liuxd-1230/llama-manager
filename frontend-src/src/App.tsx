import { AboutPage } from './features/atelier/AboutPage'
import { useMotionPreference } from './hooks/useMotionPreference'
import { SettingsPage } from './features/atelier/SettingsPage'
import { Activity, Bot, Boxes, Gauge, Moon, Pause, PenLine, Play, Settings, SlidersHorizontal, Sun, Wrench, Zap, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HashRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { api } from './api'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { AtelierGlyph, WorkspaceLoading } from './components/AtelierBrand'
import { SettingsDrawer } from './components/SettingsDrawer'
import { Badge, Button, uiStyles } from './components/ui'
import type { Accent, AppConfig, Theme } from './types'
import { defaultConfig } from './types'
import styles from './App.module.css'
import { OverviewPage } from './features/atelier/OverviewPage'
import { ProjectBar } from './features/atelier/ProjectBar'
import { TasksDrawer } from './features/atelier/Jobs'
import { Download, Home, Layers, ListTodo, Palette } from 'lucide-react'

const nav = [
  { id: '', label: '工作台', icon: Home },
  { id: 'studio', label: '创作', icon: Palette },
  { id: 'models', label: '模型', icon: Boxes },
  { id: 'downloads', label: '下载', icon: Download },
  { id: 'assets', label: '素材', icon: Layers },
  { id: 'chat', label: '对话', icon: Bot },
] as const

const DownloadsPage = lazy(() => import('./features/atelier/DownloadsPage').then(module => ({default:module.DownloadsPage})))
const AssetsPage = lazy(() => import('./features/atelier/AssetsPage').then(module => ({default:module.AssetsPage})))
const ConfigPage = lazy(() => import('./features/config/ConfigPage').then(module => ({ default: module.ConfigPage })))
const RunPage = lazy(() => import('./features/run/RunPage').then(module => ({ default: module.RunPage })))
const StudioPage = lazy(() => import('./features/studio/StudioPage').then(module => ({ default: module.PromptStudioPage })))
const ModelsPage = lazy(() => import('./features/models/ModelsPage').then(module => ({ default: module.ModelsPage })))
const MaintenancePage = lazy(() => import('./features/maintenance/MaintenancePage').then(module => ({ default: module.MaintenancePage })))
const ChatPage = lazy(() => import('./features/chat/ChatPage').then(module => ({ default: module.ChatPage })))

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 3000, retry: 1, refetchOnWindowFocus: false } } })

export default function App() {
  return <QueryClientProvider client={queryClient}><AppErrorBoundary><HashRouter><Shell /></HashRouter></AppErrorBoundary></QueryClientProvider>
}

function Shell() {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme)
  const [accent, setAccentState] = useState<Accent>(resolveInitialAccent)
  const [config, setConfig] = useState<AppConfig>(defaultConfig)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [studioVisited, setStudioVisited] = useState(false)
  const [navCollapsed,setNavCollapsed] = useState(()=>localStorage.getItem('atelier-nav-collapsed')==='true')
  const [settingsTab, setSettingsTab] = useState<'providers' | 'search' | 'appearance' | 'studio'>('providers')
  useEffect(() => {
    // Studio surfaces ask for the global drawer's 提示词工坊 tab via this event.
    const openStudioSettings = () => { setSettingsTab('studio'); setSettingsOpen(true) }
    window.addEventListener('llm-open-settings', openStudioSettings)
    return () => window.removeEventListener('llm-open-settings', openStudioSettings)
  }, [])
  const [toastText, setToastText] = useState('')
  const [providerRefresh, setProviderRefresh] = useState(0)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const main = useRef<HTMLElement>(null)
  const reduced = useMotionPreference()
  const location = useLocation()
  useEffect(() => { if (location.pathname === '/studio') setStudioVisited(true) }, [location.pathname])
  const toast = useCallback((text: string) => { setToastText(text); window.setTimeout(() => setToastText(current => current === text ? '' : current), 5000) }, [])
  const setTheme = (next: Theme) => { setThemeState(next); localStorage.setItem('theme', next) }
  const setAccent = (next: Accent) => { setAccentState(next); localStorage.setItem('accent', next) }
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => { document.documentElement.dataset.accent = accent }, [accent])
  // One poll feeds both top-bar readouts; /server/status and /host/resources
  // stay available for pages that need a single piece on demand.
  const summaryQuery = useQuery({
    queryKey: ['server-summary'],
    queryFn: () => api<{ server: { state: string; pid?: number; profile?: string }; resources: { ram: { used_mib: number; total_mib: number } | null; gpu: { used_mib: number; total_mib: number } | null } }>('/api/v1/server/summary'),
    refetchInterval: 3000,
  })
  const server = summaryQuery.data?.server ?? { state: 'stopped' }
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => api<AppConfig>('/api/v1/config') })
  const [suspending, setSuspending] = useState(false)
  const suspend = async () => {
    setSuspending(true)
    try { await api('/api/v1/server/suspend', { method: 'POST' }); toast('已暂停，显存已释放'); await queryClient.invalidateQueries({ queryKey: ['server-summary'] }) }
    catch (reason) { toast(`暂停失败：${reason instanceof Error ? reason.message : String(reason)}`) }
    finally { setSuspending(false) }
  }
  const resume = async () => {
    setSuspending(true)
    try { await api('/api/v1/server/resume', { method: 'POST', body: JSON.stringify({}) }); toast('已恢复上次档案'); await queryClient.invalidateQueries({ queryKey: ['server-summary'] }) }
    catch (reason) { toast(`恢复失败：${reason instanceof Error ? reason.message : String(reason)}`) }
    finally { setSuspending(false) }
  }
  const host = summaryQuery.data?.resources
  const gib = (mib: number) => (mib / 1024).toFixed(1)
  // A 404 here means the backend predates /api/v1/server/summary; say so instead of
  // leaving the capsule on a placeholder that looks like a slow load forever.
  const hostError = summaryQuery.isError ? (summaryQuery.error instanceof Error ? summaryQuery.error.message : String(summaryQuery.error)) : ''
  const resourceTitle = host
    ? `显存 ${host.gpu ? `${gib(host.gpu.used_mib)} / ${gib(host.gpu.total_mib)} GB` : '不可用'} · 内存 ${host.ram ? `${gib(host.ram.used_mib)} / ${gib(host.ram.total_mib)} GB` : '不可用'}`
    : hostError ? `无法读取主机占用：${hostError}（后端可能未重启）` : '正在读取主机占用…'
  const savedConfig = useRef('')
  useEffect(() => {
    if (!configQuery.data) return
    // Normalize against version skew: an older backend omits newer fields and
    // a crashed render on undefined is worse than a stale empty string.
    const data = {
      ...configQuery.data,
      chat_template_file: configQuery.data.chat_template_file ?? '',
      ninfer: { ...defaultConfig.ninfer, ...configQuery.data.ninfer },
    }
    savedConfig.current = JSON.stringify(data)
    setConfig(data)
  }, [configQuery.data])
  useEffect(() => { if (configQuery.isError) toast(`读取配置失败：${(configQuery.error as Error).message}`) }, [configQuery.isError, configQuery.error, toast])
  // Dirty = the local editor buffer differs from the last server-saved snapshot.
  const dirty = useMemo(() => configQuery.isSuccess && JSON.stringify(config) !== savedConfig.current, [config, configQuery.isSuccess])
  useEffect(() => {
    main.current?.scrollTo({top:0});
    if (reduced || !main.current?.animate) return;
    const animation=main.current.animate([{transform:'translateY(6px)'},{transform:'translateY(0)'}],{duration:190,easing:'cubic-bezier(.22,1,.36,1)'});
    return()=>animation.cancel();
  }, [location.pathname,reduced])

  return <div className={styles.root}>
    <div className={styles.layout} data-nav-collapsed={navCollapsed}>
      <header className={styles.topbar}>
        <Link to="/" aria-label="Atelier 工作台" className={styles.brand}><span className={styles.brandMark}><AtelierGlyph interactive /></span><div><div className={styles.brandText}>Atelier</div></div></Link>
        <div className={styles.topMeta}><span className={styles.serverAddress}>{ENGINE_LABELS[config.engine] || config.engine} · {config.server.host}:{config.server.port}</span>{dirty && <button type="button" className={styles.dirtyButton} title="有未保存的配置修改，点击前往配置页" onClick={() => navigate('/config')}><Badge tone="warn">未保存</Badge></button>}<Badge tone={server.state === 'running' ? 'good' : 'neutral'}><Gauge size={12}/>{server.state === 'running' ? `运行中 · ${server.pid || ''}` : '已停止'}</Badge><span className={styles.resources} title={resourceTitle} data-error={hostError ? true : undefined}>
          {host?.gpu && <span className={styles.resourceItem} data-kind="gpu">显存 <b>{gib(host.gpu.used_mib)}</b>/{gib(host.gpu.total_mib)}G</span>}
          {host?.ram && <span className={styles.resourceItem} data-kind="ram">内存 <b>{gib(host.ram.used_mib)}</b>/{gib(host.ram.total_mib)}G</span>}
          {!host && <span className={styles.resourceItem}>{hostError ? '占用不可用' : '读取中…'}</span>}
        </span>
        {server.state === 'running'
          ? <Button iconOnly title="暂停：停止本地引擎，释放显存" disabled={suspending} onClick={() => void suspend()}><Pause size={15}/></Button>
          : <Button iconOnly title="恢复：重新拉起上次使用的档案" disabled={suspending} onClick={() => void resume()}><Play size={15}/></Button>}
        <Button iconOnly title="查看任务" onClick={() => setTasksOpen(true)}><ListTodo size={17}/></Button><Button iconOnly title="切换主题" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={16}/> : <Sun size={16}/>}</Button></div>
      </header>
      <aside className={styles.sidebar}><nav className={styles.nav}>{nav.map(item => <NavLink key={item.id} end={item.id === ''} to={`/${item.id}`} aria-label={item.label} title={item.label} className={({ isActive }) => `${styles.navLink} ${isActive || (item.id === 'models' && ['/config', '/run'].includes(location.pathname)) ? styles.navLinkActive : ''}`}>{({ isActive }) => <>{(isActive || (item.id === 'models' && ['/config', '/run'].includes(location.pathname))) && <motion.span className={styles.navPaper} layoutId="atelier-navigation" transition={{duration:reduced ? 0 : .22,ease:[.22,1,.36,1]}} />}<item.icon size={16}/><span>{item.label}</span></>}</NavLink>)}</nav><div className={styles.sidebarBottom}><Link to="/about" className={styles.aboutLink} title="关于 Atelier" aria-label="关于 Atelier"><AtelierGlyph interactive/><span>关于 Atelier</span></Link><Button className={styles.settingsButton} title="设置" aria-label="设置" onClick={() => navigate('/settings')}><Settings size={16}/><span>设置</span></Button><Button className={styles.collapseNav} aria-label={navCollapsed?'展开侧栏':'折叠侧栏'} title={navCollapsed?'展开侧栏':'折叠侧栏'} aria-expanded={!navCollapsed} onClick={()=>setNavCollapsed(value=>{localStorage.setItem('atelier-nav-collapsed',String(!value));return !value})}>{navCollapsed?<PanelLeftOpen size={16}/>:<PanelLeftClose size={16}/>}</Button></div></aside>
      <main className={styles.main} ref={main}>
        <Suspense fallback={<WorkspaceLoading>正在加载工作区…</WorkspaceLoading>}><Routes>
          <Route path="/" element={<OverviewPage toast={toast}/>}/>
          <Route path="/downloads" element={<DownloadsPage toast={toast}/>}/>
          <Route path="/assets" element={<AssetsPage toast={toast}/>}/>
          <Route path="/about" element={<AboutPage/>}/>
          <Route path="/settings" element={<SettingsPage open={tab=>{setSettingsTab(tab);setSettingsOpen(true)}}/>}/>
          <Route path="/models" element={<Page title="模型" description="一键加载并切换整套推理配置"><ModelsPage config={config} dirty={dirty} server={server} toast={toast}/></Page>}/>
          <Route path="/config" element={<Page title="配置" description="编辑当前档案的模型、推理、采样和服务参数"><ConfigPage config={config} setConfig={setConfig} dirty={dirty} toast={toast}/></Page>}/>
          <Route path="/run" element={<Page title="运行" description="控制 llama-server 并观察实时状态"><RunPage config={config} toast={toast}/></Page>}/>
          <Route path="/studio" element={<span hidden/>}/>
          <Route path="/maintenance" element={<Page title="维护" description="下载、更新和编译 llama.cpp"><MaintenancePage config={config} setConfig={setConfig} toast={toast}/></Page>}/>
          {/* Chat renders outside the routes and stays mounted: switching
              pages must not drop the conversation or a running generation. */}
          <Route path="/chat" element={<span hidden/>}/>
          <Route path="*" element={<Navigate to="/" replace/>}/>
        </Routes></Suspense>
        {(studioVisited || location.pathname === '/studio') && <div className={styles.studioHost} style={{ display: location.pathname === '/studio' ? 'flex' : 'none' }}><ProjectBar/><Suspense fallback={<WorkspaceLoading>正在加载创作台…</WorkspaceLoading>}><StudioPage/></Suspense></div>}
        <div style={{ display: location.pathname === '/chat' ? 'contents' : 'none' }}>
          <Suspense fallback={<WorkspaceLoading>正在加载工作区…</WorkspaceLoading>}>
            <div className={styles.chatHost}>
              <ChatPage toast={toast} providerRefresh={providerRefresh} defaultThinking={config.basic.enable_thinking} config={config}/>
            </div>
          </Suspense>
        </div>
      </main>
    </div>
    <TasksDrawer open={tasksOpen} onClose={() => setTasksOpen(false)} toast={toast}/>
    <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} tab={settingsTab} onTabChange={setSettingsTab} theme={theme} setTheme={setTheme} accent={accent} setAccent={setAccent} onProvidersChanged={() => { setProviderRefresh(value => value + 1); window.dispatchEvent(new Event("atelier-providers-changed")) }} toast={toast}/>
    {toastText && <motion.div role="status" aria-live="polite" className={uiStyles.toast} initial={reduced ? false : { y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: reduced ? 0 : .18 }}>{toastText}</motion.div>}
  </div>
}

export function resolveInitialTheme(): Theme {
  const saved = localStorage.getItem('theme') as Theme | null
  return saved === 'dark' || saved === 'light' ? saved : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
}

export function resolveInitialAccent(): Accent {
  const saved = localStorage.getItem('accent') as Accent | null
  return saved === 'violet' || saved === 'ocean' || saved === 'amber' ? saved : 'coral'
}

const ENGINE_LABELS: Record<string, string> = { 'llama.cpp': 'llama.cpp', kvmem: 'KVMem', ninfer: 'NInfer' }

function Page({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className={`${styles.page} ${title === '对话' ? styles.chatPage : ''}`}>{['模型', '配置', '运行'].includes(title) && <nav className={styles.modelTabs} aria-label="模型工作区"><NavLink to="/models">模型档案</NavLink><NavLink to="/config">配置</NavLink><NavLink to="/run">运行与日志</NavLink></nav>}<header className={styles.pageHeader}><div><h1>{title}</h1><p>{description}</p></div></header>{children}</section>
}
