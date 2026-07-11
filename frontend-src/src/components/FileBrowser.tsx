import { File, Folder, HardDrive, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Button, Input, Panel } from './ui'
import styles from './FileBrowser.module.css'

interface Entry { name: string; path: string; is_dir: boolean; size_mb: number }

export function FileBrowser({ mode, extension = '', initialPath = '', onSelect, onClose }: { mode: 'file' | 'folder'; extension?: string; initialPath?: string; onSelect: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState(initialPath)
  const [entries, setEntries] = useState<Entry[]>([])
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')

  const browse = async (next = path) => {
    setError('')
    try {
      if (!next) {
        const result = await api<{ drives: string[] }>('/api/drives')
        setEntries(result.drives.map(drive => ({ name: drive, path: drive, is_dir: true, size_mb: 0 })))
        setPath('')
        return
      }
      const result = await api<{ entries: Entry[]; current: string }>(`/api/browse?dir=${encodeURIComponent(next)}`)
      setEntries((result.entries || []).filter(entry => entry.is_dir || !extension || entry.name.toLowerCase().endsWith(extension.toLowerCase())))
      setPath(result.current || next)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  useEffect(() => { void browse(initialPath) }, [])
  const open = (entry: Entry) => {
    if (entry.is_dir) void browse(entry.path)
    else setSelected(entry.path)
  }
  const up = () => {
    if (!path) return void browse('')
    const normalized = path.replace(/[\\/]+$/, '')
    const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
    void browse(index <= 2 ? '' : normalized.slice(0, index))
  }

  return <div className={styles.overlay} role="dialog" aria-modal="true">
    <Panel className={styles.dialog} title={mode === 'folder' ? '选择文件夹' : '选择文件'} actions={<Button iconOnly onClick={onClose} title="关闭"><X size={16} /></Button>}>
      <div className={styles.path}><Button onClick={up}>上一级</Button><Input value={path} onChange={event => setPath(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void browse() }} /><Button onClick={() => void browse()}>前往</Button></div>
      <div className={styles.list}>
        {entries.map(entry => <button key={entry.path} className={`${styles.entry} ${selected === entry.path ? styles.selected : ''}`} onDoubleClick={() => open(entry)} onClick={() => entry.is_dir ? setSelected(entry.path) : setSelected(entry.path)}>
          {entry.is_dir ? (path ? <Folder size={16} /> : <HardDrive size={16} />) : <File size={16} />}
          <span>{entry.name}</span>{!entry.is_dir && <small>{entry.size_mb.toFixed(1)} MB</small>}
        </button>)}
        {error && <div>{error}</div>}
      </div>
      <div className={styles.footer}><Button onClick={onClose}>取消</Button><Button tone="primary" disabled={mode === 'file' ? !selected || entries.find(entry => entry.path === selected)?.is_dir : false} onClick={() => onSelect(mode === 'folder' ? (selected || path) : selected)}>选择</Button></div>
    </Panel>
  </div>
}
