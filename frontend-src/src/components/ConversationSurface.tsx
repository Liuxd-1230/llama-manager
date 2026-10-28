import { useId, useState, type HTMLAttributes, type ReactNode } from 'react'
import { BrainCircuit, ChevronDown, Wrench } from 'lucide-react'
import styles from './ConversationSurface.module.css'

export function ConversationDisclosure({ label, detail, children, icon, initialOpen = false, busy = false }: { label: string; detail?: string; children: ReactNode; icon?: ReactNode; initialOpen?: boolean; busy?: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  const id = useId()
  return <section className={styles.disclosure} data-busy={busy || undefined}>
    <button type="button" className={styles.trigger} aria-label={detail ? `${label} ${detail}` : label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)}>
      {icon || <BrainCircuit size={14} aria-hidden="true" />}<span>{label}</span>{detail && <small>{detail}</small>}<ChevronDown size={13} className={open ? styles.rotated : ''} aria-hidden="true" />
    </button>
    <div className={styles.reveal} data-open={open} id={id} inert={!open}><div><div className={styles.content}>{children}</div></div></div>
  </section>
}

export function ConversationTool({ label, result, failed = false, brief }: { label: string; result: string; failed?: boolean; brief?: string }) {
  return <ConversationDisclosure icon={<Wrench size={13} aria-hidden="true" />} label={label} detail={failed ? '失败' : brief || '已完成'}><pre className={styles.result}>{result || '此工具没有返回文本。'}</pre></ConversationDisclosure>
}

export function ConversationComposer({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`${styles.composer} ${className}`} role="group" aria-label="消息输入区">{children}</div>
}
