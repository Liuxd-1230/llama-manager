import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ArrowUpRight, Bot, FolderOpen, Image, LockKeyhole, Palette, Wand2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api'

function BackupButton() {
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)
  return <span className={styles.backupInline}><Button disabled={busy} onClick={async () => { setBusy(true); try { const r = await api<{ path: string }>('/api/v1/data/backup', { method: 'POST' }); setResult(r.path) } catch (reason) { setResult(`备份失败：${reason instanceof Error ? reason.message : String(reason)}`) } finally { setBusy(false) } }}>备份数据</Button>{result && <code className={styles.backupPath} title={result}>{result}</code>}</span>
}
import { Button } from '../../components/kit'
import styles from './atelier.module.css'

type Tab = 'providers' | 'search' | 'appearance' | 'studio'
export function SettingsPage({ open }: { open: (tab: Tab) => void }) {
  const navigate = useNavigate()
  const info = useQuery({queryKey:['atelier-overview'],queryFn:()=>api<{data_dir:string}>('/api/v1/overview')})
  const rows = [
    {icon:Palette,title:'外观与交互',description:'深浅主题、强调色、品牌构造与减少动态效果。',action:'调整外观',run:()=>open('appearance')},
    {icon:Bot,title:'Agent 与模型',description:'共享模型服务、API 密钥、Agent 主模型及连接测试。',action:'模型服务',run:()=>open('providers'),secondary:{label:'Agent 参数',run:()=>open('studio')}},
    {icon:Wand2,title:'创作与 Skill',description:'Skill 组织起稿与改稿指导；预设保存可复用的指令和参数。',action:'管理 Skill',run:()=>{navigate('/studio?panel=skills')},secondary:{label:'预设与笔记',run:()=>navigate('/assets')}},
    {icon:Image,title:'图像与工作流',description:'连接已有 ComfyUI，导入工作流；节点参数与绑定随工作流保存。',action:'图像服务',run:()=>open('studio'),secondary:{label:'出图工作区',run:()=>{navigate('/studio?panel=image')}}},
    {icon:FolderOpen,title:'文件与下载',description:'选择模型、素材与下载位置；模型文件和缓存保留在原路径。',action:'下载管理',run:()=>navigate('/downloads'),secondary:{label:'引擎维护',run:()=>navigate('/maintenance')}},
    {icon:LockKeyhole,title:'隐私与高级',description:'凭据保存在 Windows 加密存储或环境变量。对话与作品保存在本机；连接外部服务时发送所需内容。',action:'搜索服务',run:()=>open('search'),secondary:{label:'MCP 工具',run:()=>navigate('/assets')},tertiary:{label:'备份数据',run:null}}
  ]
  return <div className={styles.workspace}><div className={styles.pageHeading}><div><h1>设置</h1><p>让工具适应你的创作习惯。</p></div></div><div className={styles.settingsRows}>{rows.map(row=><section key={row.title}><row.icon size={19} aria-hidden="true"/><div><h2>{row.title}</h2><p>{row.description}</p></div><div><Button onClick={row.run}>{row.action}<ArrowUpRight size={13}/></Button>{row.secondary && <Button onClick={row.secondary.run}>{row.secondary.label}</Button>}{row.tertiary && <BackupButton/>}</div></section>)}</div><div className={styles.dataLocation}><strong>当前数据位置</strong><code>{info.data?.data_dir || '正在读取…'}</code><p>首次迁移的备份与校验记录保存在此目录的 migration.json 中。大型模型与缓存不随数据迁移。</p></div></div>
}
