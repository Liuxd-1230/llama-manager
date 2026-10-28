import { ArrowRight } from 'lucide-react'
import { useEffect,useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../api'
import { activateProject } from '../studio/projects'
import { toast as studioToast,useStore } from '../studio/store'
import styles from './atelier.module.css'


import { errorText,type Asset } from './atelierApi'

export function ProjectBar() {
  const [projects, setProjects] = useState<Asset[]>([])
  const current = useStore(state=>state.projectId)
  useEffect(() => { void api<Asset[]>('/api/v1/objects/project').then(setProjects).catch(() => undefined) }, [])
  const select = async (id: string) => { try { await activateProject(id) } catch (e) { studioToast(errorText(e), 'err') } }
  return <div className={styles.projectBar}><span>项目</span><select aria-label="当前创作项目" value={current} onChange={e => void select(e.target.value)}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><Link to="/">项目列表 <ArrowRight size={13} /></Link></div>
}
