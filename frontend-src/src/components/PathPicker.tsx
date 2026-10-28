import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { FileBrowser } from './FileBrowser'
import { Button, Input } from './kit'

export function PathPicker({ value, onChange, mode = 'folder', label = '目标目录' }: { value: string; onChange: (path: string) => void; mode?: 'folder' | 'file'; label?: string }) {
  const [open, setOpen] = useState(false)
  return <><div style={{display:'flex',gap:8,minWidth:0}}><Input aria-label={label} style={{minWidth:0,flex:1}} value={value} placeholder="选择位置或输入完整路径…" onChange={e=>onChange(e.target.value)}/><Button title={`选择${mode==='folder'?'文件夹':'文件'}`} onClick={()=>setOpen(true)}><FolderOpen size={16}/></Button></div>{open && <FileBrowser mode={mode} initialPath={value} onClose={()=>setOpen(false)} onSelect={path=>{onChange(path);setOpen(false)}}/>}</>
}
