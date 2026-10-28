import styles from './atelier.module.css';
import { errorText } from './atelierApi';

export function ErrorNotice({ error }: { error: unknown }) { return error ? <div className={styles.error} role="alert">{errorText(error)}</div> : null }
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) { return <div className={styles.empty}><h3>{title}</h3><p>{children}</p></div> }
