import { motion, useReducedMotion } from 'motion/react'
import { useId, useRef } from 'react'
import styles from './SegmentedControl.module.css'

export function SegmentedControl({ label, value, options, onChange, className = '' }: {
  label: string
  value: string
  options: readonly { id: string; label: string }[]
  onChange: (value: string) => void
  className?: string
}) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  return <div ref={root} role="toolbar" aria-label={label} aria-orientation="horizontal" className={`${styles.control} ${className}`}>
    {options.map((option, index) => <button key={option.id} type="button" aria-pressed={value === option.id} tabIndex={value === option.id ? 0 : -1}
      onClick={() => onChange(option.id)} onKeyDown={event => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length
        onChange(options[next].id)
        root.current?.querySelectorAll('button')[next]?.focus()
      }}>
      {value === option.id && <motion.span className={styles.indicator} layoutId={`segment-${id}`} transition={{ duration: reduced ? 0 : .16, ease: [.22,1,.36,1] }} />}
      <span>{option.label}</span>
    </button>)}
  </div>
}
