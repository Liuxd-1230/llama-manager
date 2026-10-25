import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from './ui'
import styles from './ui.module.css'

const focusable = 'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]'

// Shared focus lifecycle for overlays, including drawers rendered via portals.
export function useModalFocus<T extends HTMLElement = HTMLDivElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open || !ref.current) return
    const previous = document.activeElement as HTMLElement | null
    const container = ref.current
    const controls = () => Array.from(container.querySelectorAll<HTMLElement>(focusable)).filter(element => !element.closest('[hidden]') && (!element.closest('details:not([open])') || element.tagName === 'SUMMARY') && getComputedStyle(element).display !== 'none')
    const frame = requestAnimationFrame(() => (container.querySelector<HTMLElement>('[data-autofocus]') ?? container).focus())
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
      if (event.key !== 'Tab') return
      const items = controls()
      const first = items[0], last = items[items.length - 1]
      if (!first) { event.preventDefault(); container.focus(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === container)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === container)) { event.preventDefault(); first.focus() }
    }
    const focusin = (event: FocusEvent) => { if (!container.contains(event.target as Node)) container.focus() }
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('focusin', focusin)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('focusin', focusin)
      if (previous?.isConnected) previous.focus()
    }
  }, [open])
  return ref
}

export function Modal({ title, onClose, children, className = '', backdropClassName = '', icon, head, foot, wide = false, xl = false }: { title: string; onClose: () => void; children: ReactNode; className?: string; backdropClassName?: string; icon?: ReactNode; head?: ReactNode; foot?: ReactNode; wide?: boolean; xl?: boolean }) {
  const ref = useModalFocus(true, onClose)
  return createPortal(<div className={`${styles.modalBackdrop} ${backdropClassName}`} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className={[styles.dialog, wide ? styles.wide : '', xl ? styles.xl : '', className].filter(Boolean).join(' ')}>
      {icon !== undefined && <header className={styles.dialogHeader}>
        <div className={styles.dialogHeaderTitle}>{icon}{title}</div>
        {head}
        <Button iconOnly size="small" title="关闭 (Esc)" aria-label="关闭" onClick={onClose}><X size={15} /></Button>
      </header>}
      {children}
      {foot && <footer className={styles.dialogFooter}>{foot}</footer>}
    </div>
  </div>, document.body)
}

export function ConfirmDialog({ title, description, confirmLabel, onClose, onConfirm, pending = false }: { title: string; description: string; confirmLabel: string; onClose: () => void; onConfirm: () => void; pending?: boolean }) {
  return <Modal title={title} onClose={pending ? () => {} : onClose}>
    <h2 className={styles.dialogTitle}>{title}</h2><p className={styles.dialogDescription}>{description}</p>
    <div className={styles.dialogActions}><Button disabled={pending} onClick={onClose}>取消</Button><Button tone="danger" disabled={pending} onClick={onConfirm}>{pending ? '处理中…' : confirmLabel}</Button></div>
  </Modal>
}
