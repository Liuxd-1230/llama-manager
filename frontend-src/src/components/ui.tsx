import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import styles from './ui.module.css'

export function Button({ tone = 'default', size = 'normal', iconOnly = false, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'primary' | 'danger' | 'success'; size?: 'normal' | 'small'; iconOnly?: boolean }) {
  return <button {...props} className={[styles.button, styles[tone], size === 'small' ? styles.small : '', iconOnly ? styles.iconButton : '', className].filter(Boolean).join(' ')} />
}

export function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return <label className={`${styles.field} ${className}`}><span className={styles.label}>{label}</span>{children}</label>
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className={`${styles.input} ${props.className || ''}`} /> }
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) { return <select {...props} className={`${styles.select} ${props.className || ''}`} /> }
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...props} className={`${styles.textarea} ${props.className || ''}`} /> }

export function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return <label className={styles.switch}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    <span className={styles.track}><span className={styles.thumb} /></span>
    <span>{label}</span>
  </label>
}

export function Panel({ title, icon, actions, children, className = '' }: { title?: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`${styles.panel} ${className}`}>
    {title && <header className={styles.panelHeader}><div className={styles.panelTitle}>{icon}{title}</div>{actions}</header>}
    <div className={styles.panelBody}>{children}</div>
  </section>
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'bad' | 'warn' }) {
  return <span className={styles.badge} data-tone={tone}>{children}</span>
}

export { styles as uiStyles }
