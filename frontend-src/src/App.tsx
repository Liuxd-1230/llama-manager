import { Activity, Bot, Boxes, ClipboardCheck, Gauge, ListTodo, Moon, Settings, SlidersHorizontal, Sun, Wrench, Zap } from 'lucide-react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, useReducedMotion } from 'motion/react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HashRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { api } from './api'
import { SettingsDrawer } from './components/SettingsDrawer'
import { TaskCenter } from './components/TaskCenter'
import { Badge, Button, uiStyles } from './components/ui'
import type { AppConfig, Theme } from './types'
import { defaultConfig } from './types'
import styles from './App.module.css'

const nav = [
  { id: 'models', label: '模型', icon: Boxes },
  { id: 'config', label: '配置', icon: SlidersHorizontal },
  { id: 'run', label: '运行', icon: Activity },
  { id: 'evaluation', label: '评测', icon: ClipboardCheck },
  { id: 'maintenance', label: '维护', icon: Wrench },
  { id: 'chat', label: '对话', icon: Bot },
] as const

const ConfigPage = lazy(() => import('./features/config/ConfigPage').then(module => ({ default: module.ConfigPage })))
const RunPage = lazy(() => import('./features/run/RunPage').then(module => ({ default: module.RunPage })))
const EvaluationPage = lazy(() => import('./features/evaluation/EvaluationPage').then(module => ({ default: module.EvaluationPage })))
const ModelsPage = lazy(() => import('./features/models/ModelsPage').then(module => ({ default: module.ModelsPage })))
const MaintenancePage = lazy(() => import('./features/maintenance/MaintenancePage').then(module => ({ default: module.MaintenancePage })))
const ChatPage = lazy(() => import('./features/chat/ChatPage').then(module => ({ default: module.ChatPage })))

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 3000, retry: 1, refetchOnWindowFocus: false } } })

export default function App() {
  return <QueryClientProvider client={queryClient}><HashRouter><Shell /></HashRouter></QueryClientProvider>
}

function Shell() {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme)
  const [config, setConfig] = useState<AppConfig>(defaultConfig)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [toastText, setToastText] = useState('')
  const [scrolled, setScrolled] = useState(false)
  const [providerRefresh, setProviderRefresh] = useState(0)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const root = useRef<HTMLDivElement>(null)
  const main = useRef<HTMLElement>(null)
  const reduced = useReducedMotion()
  const location = useLocation()
  const toast = useCallback((text: string) => { setToastText(text); window.setTimeout(() => setToastText(current => current === text ? '' : current), 2600) }, [])
  const setTheme = (next: Theme) => { setThemeState(next); localStorage.setItem('theme', next) }
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  const serverQuery = useQuery({ queryKey: ['server-status'], queryFn: () => api<{ state: string; pid?: number; profile?: string }>('/api/server/status'), refetchInterval: 4000 })
  const server = serverQuery.data ?? { state: 'stopped' }
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => api<AppConfig>('/api/config') })
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
  useEffect(() => { main.current?.scrollTo({ top: 0 }); setScrolled(false) }, [location.pathname])
  const pointer = (event: React.PointerEvent) => {
    if (reduced || !root.current) return
    root.current.style.setProperty('--pointer-x', `${(event.clientX / innerWidth) * 100}%`)
    root.current.style.setProperty('--pointer-y', `${(event.clientY / innerHeight) * 100}%`)
  }

  return <div className={styles.root} ref={root} onPointerMove={pointer}>
    <div className={styles.flow}/>
    <div className={styles.layout}>
      <header className={`${styles.topbar} ${scrolled ? styles.topbarScrolled : ''}`}>
        <div className={styles.brand}><span className={styles.brandMark}><Zap size={18}/></span><div><div className={styles.brandText}>llama.cpp Manager</div><div className={styles.brandSub}>本地推理控制台</div></div></div>
        <div className={styles.topMeta}><span className={styles.serverAddress}>{config.server.host}:{config.server.port}</span>{dirty && <button type="button" className={styles.dirtyButton} title="有未保存的配置修改，点击前往配置页" onClick={() => navigate('/config')}><Badge tone="warn">未保存</Badge></button>}<Badge tone={server.state === 'running' ? 'good' : 'neutral'}><Gauge size={12}/>{server.state === 'running' ? `运行中 · ${server.pid || ''}` : '已停止'}</Badge><Button iconOnly title="任务中心" onClick={() => setTasksOpen(true)}><ListTodo size={16}/></Button><Button iconOnly title="切换主题" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={16}/> : <Sun size={16}/>}</Button></div>
      </header>
      <aside className={styles.sidebar}><nav className={styles.nav}>{nav.map(item => <NavLink key={item.id} to={`/${item.id}`} className={({ isActive }) => `${styles.navLink} ${isActive ? styles.navLinkActive : ''}`}><item.icon size={16}/><span>{item.label}</span></NavLink>)}</nav><div className={styles.sidebarBottom}><Button className={styles.settingsButton} onClick={() => setSettingsOpen(true)}><Settings size={16}/>设置</Button></div></aside>
      <main className={styles.main} ref={main} onScroll={event => setScrolled(event.currentTarget.scrollTop > 16)}>
        <Suspense fallback={<div className={styles.page}>正在加载工作区…</div>}><Routes>
          <Route path="/" element={<Navigate to="/models" replace/>}/>
          <Route path="/models" element={<Page title="模型" description="一键加载并切换整套推理配置"><ModelsPage config={config} dirty={dirty} server={server} toast={toast}/></Page>}/>
          <Route path="/config" element={<Page title="配置" description="编辑当前档案的模型、推理、采样和服务参数"><ConfigPage config={config} setConfig={setConfig} dirty={dirty} toast={toast}/></Page>}/>
          <Route path="/run" element={<Page title="运行" description="控制 llama-server 并观察实时状态"><RunPage config={config} toast={toast}/></Page>}/>
          <Route path="/evaluation" element={<Page title="评测" description="用真实任务比较模型质量与响应表现"><EvaluationPage toast={toast}/></Page>}/>
          <Route path="/maintenance" element={<Page title="维护" description="下载、更新和编译 llama.cpp"><MaintenancePage config={config} setConfig={setConfig} toast={toast}/></Page>}/>
          {/* Chat renders outside the routes and stays mounted: switching
              pages must not drop the conversation or a running generation. */}
          <Route path="/chat" element={<span hidden/>}/>
          <Route path="*" element={<Navigate to="/models" replace/>}/>
        </Routes></Suspense>
        <div style={{ display: location.pathname === '/chat' ? undefined : 'none' }}>
          <Suspense fallback={<div className={styles.page}>正在加载工作区…</div>}>
            <Page title="对话" description="本地模型与外部 API 的统一流式对话">
              <ChatPage toast={toast} providerRefresh={providerRefresh} defaultThinking={config.basic.enable_thinking}/>
            </Page>
          </Suspense>
        </div>
      </main>
    </div>
    <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} theme={theme} setTheme={setTheme} onProvidersChanged={() => setProviderRefresh(value => value + 1)} toast={toast}/>
    {tasksOpen && <TaskCenter open onClose={() => setTasksOpen(false)}/>}
    {toastText && <motion.div className={uiStyles.toast} initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>{toastText}</motion.div>}
  </div>
}

export function resolveInitialTheme(): Theme {
  const saved = localStorage.getItem('theme') as Theme | null
  return saved === 'dark' || saved === 'light' ? saved : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
}

function Page({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <motion.section className={styles.page} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .18 }}><header className={styles.pageHeader}><div><h1>{title}</h1><p>{description}</p></div></header>{children}</motion.section>
}
