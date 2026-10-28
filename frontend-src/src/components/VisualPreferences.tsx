import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { MotionConfig } from 'motion/react'
import { Field, Select, Switch } from './kit'

export function loadVisualPreferences() {
  const decoration = localStorage.getItem('atelier-decoration')
  document.documentElement.dataset.decoration = ['full','compact','off'].includes(decoration || '') ? decoration! : 'full'
  document.documentElement.dataset.motion = localStorage.getItem('atelier-motion') === 'reduced' ? 'reduced' : 'system'
  window.dispatchEvent(new Event('atelier-visual-preferences'))
}

const subscribe = (notify: () => void) => { window.addEventListener('atelier-visual-preferences',notify); return () => window.removeEventListener('atelier-visual-preferences',notify) }
const motionSnapshot = () => localStorage.getItem('atelier-motion') === 'reduced'
export function VisualMotionProvider({children}:{children:ReactNode}) {
  const reduced = useSyncExternalStore(subscribe,motionSnapshot,()=>false)
  return <MotionConfig reducedMotion={reduced ? 'always' : 'user'}>{children}</MotionConfig>
}

export function VisualPreferences() {
  const [decoration, setDecoration] = useState(localStorage.getItem('atelier-decoration') || 'full')
  const [reduced, setReduced] = useState(localStorage.getItem('atelier-motion') === 'reduced')
  return <div style={{marginTop:24,display:'grid',gap:16}}><Field label="品牌艺术表现"><Select value={decoration} onChange={e=>{setDecoration(e.target.value);localStorage.setItem('atelier-decoration',e.target.value);loadVisualPreferences()}}><option value="full">完整 · 首页艺术背景与构造</option><option value="compact">精简 · 保留构造与标志</option><option value="off">关闭 · 只保留导航标志</option></Select></Field><Switch checked={reduced} label="减少动态效果" onChange={value=>{setReduced(value);localStorage.setItem('atelier-motion',value?'reduced':'system');loadVisualPreferences()}}/><p style={{fontSize:12,color:'var(--text-2)',margin:0}}>系统的减少动态效果设置始终优先。完整构造只首次进入播放，不随页面切换重复。</p></div>
}
