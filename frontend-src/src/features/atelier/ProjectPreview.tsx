import { FolioGlyph } from '../../components/AtelierBrand'
import type { Doc } from '../studio/types'
import styles from './atelier.module.css'

export function ProjectPreview({ doc }: { doc?: Doc }) {
  if (!doc) return <FolioGlyph />
  if (doc.kind === 'caption') {
    const text = doc.caption.segments?.map(segment=>segment.text).join(' ') || doc.caption.caption
    if (!text?.trim()) return <FolioGlyph />
    return <span className={styles.textFolio} aria-hidden="true">{text}</span>
  }
  const layout=doc.layout
  if (!layout?.items?.length) return <FolioGlyph />
  return <svg className={styles.layoutFolio} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true"><rect x="1" y="1" width={layout.width-2} height={layout.height-2} fill="none" stroke="currentColor" strokeWidth={layout.width/100}/>{layout.items.filter(item=>!item.hidden).map(item=>{
    const [x,y,x2,y2]=item.bbox
    return item.shape==='ellipse' ? <ellipse key={item.id} cx={(x+x2)/2} cy={(y+y2)/2} rx={(x2-x)/2} ry={(y2-y)/2} fill="currentColor" opacity=".2"/> : <rect key={item.id} x={x} y={y} width={x2-x} height={y2-y} fill="currentColor" opacity=".2"/>
  })}</svg>
}
