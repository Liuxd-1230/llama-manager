import { BrandConstruction } from '../../components/BrandConstruction'
import { AtelierGlyph } from '../../components/AtelierBrand'
import styles from './atelier.module.css'
export function AboutPage() {
  return <div className={`${styles.workspace} ${styles.about}`}><header className={styles.aboutHeading}><AtelierGlyph interactive/><div><h1>Atelier</h1><p>本地创作工作台</p></div></header><BrandConstruction/><section className={styles.aboutNotes}><h2>由构造，到创作</h2><p>同一枚几何 A，用于导航、创作、加载和任务状态。完整构造可以在这里重播，日常入口在悬停与键盘聚焦时呈现测量线。</p><p>文稿、构图与出图使用同一份项目内容。对话和作品保存在本机；连接外部模型服务时会发送所需内容。</p></section></div>
}
