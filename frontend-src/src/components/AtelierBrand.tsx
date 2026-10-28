import styles from './AtelierBrand.module.css'
import mark from '../brand/mark.json'

// User-supplied geometric A, kept identical across navigation, favicon and construction.
export const ATELIER_MARK = mark.path

export function AtelierGlyph({ className = '', drawing = false, interactive = false, state = 'idle' }: { className?: string; drawing?: boolean; interactive?: boolean; state?: 'idle'|'working'|'complete'|'error' }) {
  return <svg data-brand-mark data-state={drawing?'working':state} className={`${styles.glyph} ${interactive?styles.interactive:''} ${className}`} viewBox={mark.viewBox} aria-hidden="true"><path data-mark-solid d={ATELIER_MARK} fill="currentColor"/><path className={styles.trace} pathLength="1" d={ATELIER_MARK} stroke="currentColor" strokeWidth="1.8" fill="none"/><g className={styles.measure} fill="none" stroke="currentColor" strokeWidth="2"><path pathLength="1" d="M0 -8H163M0 -13V-3M163 -13V-3M-7 0V148M-12 0H-2M-12 148H-2"/></g></svg>
}

export function WorkspaceLoading({ children }: { children: React.ReactNode }) {
  return <div className={styles.loading} role="status"><AtelierGlyph state="working"/><span>{children}</span></div>
}

/** A printer's open frame, shared by project folios and honest empty states. */
export function FolioGlyph({ className = '' }: { className?: string }) {
  return <svg className={`${styles.folio} ${className}`} viewBox="0 0 160 180" fill="none" aria-hidden="true"><path className={styles.paper} d="M24 24V12h100l16 16v140h-12M12 36v132h100v-12M124 12v16h16" stroke="currentColor" strokeWidth="1" /><path className={styles.openFrame} d="M34 58V44h14m64 0h14v14M34 128v14h14m64 0h14v-14" stroke="currentColor" strokeWidth="1" /><path data-mark-solid d={ATELIER_MARK} transform="translate(54 65) scale(.32)" fill="currentColor"/></svg>
}
