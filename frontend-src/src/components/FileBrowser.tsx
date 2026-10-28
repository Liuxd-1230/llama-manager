import { File, Folder, HardDrive, ArrowUp, ArrowRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { api } from '../api'
import { Button, Input } from './ui'
import styles from './FileBrowser.module.css'

interface Entry { name: string; path: string; is_dir: boolean; size_mb: number }

export function FileBrowser({ mode, extension = '', initialPath = '', onSelect, onClose }: { mode: 'file' | 'folder'; extension?: string; initialPath?: string; onSelect: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState(initialPath)
  const [entries, setEntries] = useState<Entry[]>([])
  const [selected, setSelected] = useState('')
  const [browsedPath,setBrowsedPath]=useState('')
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)
  const live=useRef(true)
  const request=useRef('')
  const browseSequence=useRef(0)
  const cancelSystem = () => { const id=request.current;request.current='';if(id)void api(`/api/v1/files/pick?request_id=${encodeURIComponent(id)}`,{method:'DELETE'}).catch(()=>undefined) }
  const close = () => { live.current=false;cancelSystem();onClose() }
  useEffect(()=>{live.current=true;return()=>{live.current=false;cancelSystem()}},[])
  const systemPick = async () => {
    const id=crypto.randomUUID();request.current=id
    setPicking(true); setError('')
    try {
      const anchor={left:window.screenX,top:window.screenY,width:window.outerWidth,height:window.outerHeight}
      const result = await api<{path: string | null}>('/api/v1/files/pick', {method:'POST',body:JSON.stringify({mode,initial:path,extension,request_id:id,anchor})}, 190000)
      if (live.current && request.current===id && result.path) onSelect(result.path)
    } catch (reason) { if(live.current && request.current===id)setError(`${reason instanceof Error ? reason.message : String(reason)}。也可以在下方浏览选择。`) }
    finally { if(request.current===id)request.current='';if(live.current)setPicking(false) }
  }

  const browse = async (next = path) => {
    const sequence=++browseSequence.current
    setError('')
    try {
      if (!next) {
        const result = await api<{ drives: string[] }>('/api/v1/drives')
        if(sequence!==browseSequence.current || !live.current)return
        setEntries(result.drives.map(drive => ({ name: drive, path: drive, is_dir: true, size_mb: 0 })))
        setPath('');setBrowsedPath('');setSelected('')
        return
      }
      const result = await api<{ entries: Entry[]; current: string }>(`/api/v1/browse?dir=${encodeURIComponent(next)}`)
      if(sequence!==browseSequence.current || !live.current)return
      setEntries((result.entries || []).filter(entry => entry.is_dir || (mode==='file' && (!extension || entry.name.toLowerCase().endsWith(extension.toLowerCase())))))
      setPath(result.current || next)
      setBrowsedPath(result.current || next)
      setSelected('')
    } catch (reason) { if(sequence===browseSequence.current && live.current)setError(reason instanceof Error ? reason.message : String(reason)) }
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

  // Portal to <body>: ancestors like .main carry backdrop-filter, which turns
  // position:fixed into "fixed to the scroll container" — the dialog would
  // otherwise anchor to the top of the scrolled content and appear off-screen.
  return <Modal title={mode === 'folder' ? '选择文件夹' : '选择文件'} onClose={close} className={styles.modal} icon={<Folder size={17}/>}>
    <div className={styles.dialog}>
      <div className={styles.system}><Button disabled={picking} onClick={() => void systemPick()}><Folder size={15}/>{picking ? '请在系统窗口中选择…' : '使用系统选择窗口'}</Button>{picking && <Button onClick={cancelSystem}>取消系统选择</Button>}{error && <p role="alert">{error}</p>}</div>
      <div className={styles.path} inert={picking}><Button iconOnly title="上一级" onClick={up}><ArrowUp size={15}/></Button><Input aria-label="目录路径" value={path} onChange={event => {setPath(event.target.value);setSelected('')}} onKeyDown={event => { if (event.key === 'Enter') void browse() }} /><Button iconOnly title="前往" onClick={() => void browse()}><ArrowRight size={15}/></Button></div>
      <div className={styles.list} inert={picking} aria-label="目录内容">
        {entries.map(entry => <button key={entry.path} className={`${styles.entry} ${selected === entry.path ? styles.selected : ''}`} onDoubleClick={() => open(entry)} onClick={() => open(entry)}>
          {entry.is_dir ? (path ? <Folder size={16} /> : <HardDrive size={16} />) : <File size={16} />}
          <span>{entry.name}</span>{!entry.is_dir && <small>{entry.size_mb.toFixed(1)} MB</small>}
        </button>)}
        {!entries.length && !error && <p className={styles.empty}>此目录没有{mode==='folder'?'子文件夹':'匹配文件'}</p>}
      </div>
      <div className={styles.footer} inert={picking}><Button onClick={close}>取消</Button><Button tone="primary" disabled={mode === 'file' ? !entries.some(entry=>entry.path===selected && !entry.is_dir) : !path.trim() || path!==browsedPath} onClick={() => onSelect(mode === 'folder' ? path : selected)}>选择</Button></div>
    </div>
  </Modal>
}
