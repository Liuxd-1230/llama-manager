import { Activity, Bot, FlaskConical, Gauge, Moon, Settings, SlidersHorizontal, Sun, Wrench, Zap } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { HashRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { api } from './api'
import { SettingsDrawer } from './components/SettingsDrawer'
import { Badge, Button, uiStyles } from './components/ui'
import { useInterval } from './hooks'
import type { AppConfig, Theme } from './types'
import { defaultConfig } from './types'
import styles from './App.module.css'

const nav = [
  { id: 'config', label: '配置', icon: SlidersHorizontal },
  { id: 'run', label: '运行', icon: Activity },
  { id: 'optimize', label: '优化', icon: FlaskConical },
  { id: 'maintenance', label: '维护', icon: Wrench },
  { id: 'chat', label: '对话', icon: Bot },
] as const

const ConfigPage = lazy(() => import('./features/config/ConfigPage').then(module => ({ default: module.ConfigPage })))
const RunPage = lazy(() => import('./features/run/RunPage').then(module => ({ default: module.RunPage })))
const OptimizePage = lazy(() => import('./features/optimize/OptimizePage').then(module => ({ default: module.OptimizePage })))
const MaintenancePage = lazy(() => import('./features/maintenance/MaintenancePage').then(module => ({ default: module.MaintenancePage })))
const ChatPage = lazy(() => import('./features/chat/ChatPage').then(module => ({ default: module.ChatPage })))

export default function App() {
  return <HashRouter><Shell /></HashRouter>
}

function Shell() {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme)
  const [config, setConfig] = useState<AppConfig>(defaultConfig)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toastText, setToastText] = useState('')
  const [server, setServer] = useState<{ state: string; pid?: number }>({ state: 'stopped' })
  const [scrolled, setScrolled] = useState(false)
  const [providerRefresh, setProviderRefresh] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const main = useRef<HTMLElement>(null)
  const reduced = useReducedMotion()
  const location = useLocation()
  const toast = useCallback((text: string) => { setToastText(text); window.setTimeout(() => setToastText(current => current === text ? '' : current), 2600) }, [])
  const setTheme = (next: Theme) => { setThemeState(next); localStorage.setItem('theme', next) }
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => { api<AppConfig>('/api/config').then(setConfig).catch(reason => toast(`读取配置失败：${reason.message}`)) }, [toast])
  const refreshServer = useCallback(() => { api<{ state: string; pid?: number }>('/api/server/status').then(setServer).catch(() => setServer({ state: 'stopped' })) }, [])
  useEffect(refreshServer, [refreshServer]); useInterval(refreshServer, 4000)
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
        <div className={styles.topMeta}><span className={styles.serverAddress}>{config.server.host}:{config.server.port}</span><Badge tone={server.state === 'running' ? 'good' : 'neutral'}><Gauge size={12}/>{server.state === 'running' ? `运行中 · ${server.pid || ''}` : '已停止'}</Badge><Button iconOnly title="切换主题" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={16}/> : <Sun size={16}/>}</Button></div>
      </header>
      <aside className={styles.sidebar}><nav className={styles.nav}>{nav.map(item => <NavLink key={item.id} to={`/${item.id}`} className={({ isActive }) => `${styles.navLink} ${isActive ? styles.navLinkActive : ''}`}><item.icon size={16}/><span>{item.label}</span></NavLink>)}</nav><div className={styles.sidebarBottom}><Button className={styles.settingsButton} onClick={() => setSettingsOpen(true)}><Settings size={16}/>设置</Button></div></aside>
      <main className={styles.main} ref={main} onScroll={event => setScrolled(event.currentTarget.scrollTop > 16)}>
        <Suspense fallback={<div className={styles.page}>正在加载工作区…</div>}><Routes>
          <Route path="/" element={<Navigate to="/config" replace/>}/>
          <Route path="/config" element={<Page title="配置" description="模型、推理、采样和服务参数"><ConfigPage config={config} setConfig={setConfig} toast={toast}/></Page>}/>
          <Route path="/run" element={<Page title="运行" description="控制 llama-server 并观察实时状态"><RunPage config={config} toast={toast}/></Page>}/>
          <Route path="/optimize" element={<Page title="优化" description="使用 llama-bench 搜索更合适的推理参数"><OptimizePage toast={toast}/></Page>}/>
          <Route path="/maintenance" element={<Page title="维护" description="下载、更新和编译 llama.cpp"><MaintenancePage config={config} toast={toast}/></Page>}/>
          <Route path="/chat" element={<Page title="对话" description="本地模型与外部 API 的统一流式对话"><ChatPage toast={toast} providerRefresh={providerRefresh}/></Page>}/>
          <Route path="*" element={<Navigate to="/config" replace/>}/>
        </Routes></Suspense>
      </main>
    </div>
    <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} theme={theme} setTheme={setTheme} onProvidersChanged={() => setProviderRefresh(value => value + 1)} toast={toast}/>
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
