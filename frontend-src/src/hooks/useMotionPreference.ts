import { useSyncExternalStore } from 'react'
import { useReducedMotion } from 'motion/react'

const subscribe = (notify: () => void) => { window.addEventListener('atelier-visual-preferences',notify); return () => window.removeEventListener('atelier-visual-preferences',notify) }
const snapshot = () => localStorage.getItem('atelier-motion') === 'reduced'
/** OS preference and the explicit application setting share one decision. */
export function useMotionPreference() {
  const system = useReducedMotion()
  const explicit = useSyncExternalStore(subscribe,snapshot,()=>false)
  return Boolean(system || explicit)
}
