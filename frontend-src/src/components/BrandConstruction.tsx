import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { ATELIER_MARK } from './AtelierBrand'
import styles from './BrandConstruction.module.css'

/** Coordinates come from the supplied vector: bounds 0,0 → 163,148. */
export function BrandConstruction({ daily = false }: { daily?: boolean }) {
  const [iteration, setIteration] = useState(0)
  const [simple, setSimple] = useState(daily)
  const [animate] = useState(() => !daily && !sessionStorage.getItem('atelier-brand-seen'))
  useEffect(() => { sessionStorage.setItem('atelier-brand-seen', '1') }, [])
  return <figure className={`${styles.figure} ${daily ? styles.daily : ''}`} aria-label="Atelier 几何 A 品牌构造">
    <div className={styles.landscape} aria-hidden="true">{[0, 1, 2, 3].map(i => <img key={i} src={`/static/brand/landscape-${i}.webp`} alt="" loading="lazy" />)}</div>
    <div className={styles.board} data-simple={simple || undefined}>
      <svg key={iteration} className={`${styles.construction} ${animate || iteration ? styles.animate : ''}`} viewBox="0 0 760 290" role="img" aria-label="标志宽 163 单位，高 148 单位；同一基线上的 Atelier 字标">
        <g className={styles.guides} fill="none" stroke="currentColor" strokeWidth=".65">
          {[60, 100, 140, 180, 220, 260, 300, 340, 380, 420, 460, 500, 540, 580, 620, 660, 700].map(x => <path key={x} d={`M${x} 38V253`} />)}
          {[57, 94, 131, 168, 205, 242].map(y => <path key={y} d={`M40 ${y}H720`} />)}
          <path d="M60 65H720M60 213H720M100 38V245M263 38V245M181.5 38V245" />
          <circle className={styles.circle} pathLength="1" cx="181.5" cy="139" r="110.083" />
          <path className={styles.diagonal} pathLength="1" d="M100 213 181 65 263 213M100 65 263 213" />
        </g>
        <g className={styles.measure} fill="none" stroke="currentColor" strokeWidth=".8">
          <path pathLength="1" d="M100 44H263M100 40V48M263 40V48M77 65V213M73 65H81M73 213H81M100 232H181.5M100 228V236M181.5 228V236" />
        </g>
        <g className={styles.annotations} fill="currentColor" textAnchor="middle">
          <text x="181.5" y="35">163</text><text x="141" y="249">81.5</text>
          <text x="66" y="139" transform="rotate(-90 66 139)">148</text>
          <text x="674" y="230">基线 148</text>
        </g>
        <g transform="translate(100 65)">
          <path className={styles.outline} pathLength="1" d={ATELIER_MARK} fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path className={styles.solid} d={ATELIER_MARK} fill="currentColor" />
        </g>
        <g className={styles.wordmark} fill="currentColor">
          <text x="325" y="210">Atelier</text>
        </g>
      </svg>
    </div>
    <figcaption className={styles.caption}><span>标志构造</span><div><button type="button" aria-pressed={simple} onClick={() => setSimple(v => !v)}>{simple ? '查看构造' : '简洁标志'}</button><button type="button" aria-label="重播标志构造" title="重播标志构造" onClick={() => { setSimple(false); setIteration(v => v + 1) }}><RotateCcw size={13} /></button></div></figcaption>
  </figure>
}
