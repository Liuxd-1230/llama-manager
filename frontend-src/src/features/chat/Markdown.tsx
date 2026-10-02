import { Check, Copy, Eye, WrapText } from 'lucide-react'
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import styles from './chat.module.css'

// memo blocks re-parse of completed messages whenever a parent re-renders
// with unchanged content — the full remark/rehype pipeline only runs on real changes.
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return <div className={styles.markdown}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeSanitize, rehypeKatex]} components={{
    a: props => <a {...props} target="_blank" rel="noreferrer" />,
    pre: props => <CodeBlock {...props} language={codeLanguage(props.children)} />,
  }}>{children}</ReactMarkdown></div>
})

function codeLanguage(children: ReactNode): string | undefined {
  const first = Array.isArray(children) ? children[0] : children
  if (first && typeof first === 'object' && 'props' in first) {
    const match = /language-([\w-]+)/.exec(String((first as { props?: { className?: string } }).props?.className || ''))
    return match ? match[1].toLowerCase() : undefined
  }
  return undefined
}

function CodeBlock({ children, language, ...rest }: { children?: ReactNode; language?: string } & Record<string, unknown>) {
  const [copied, setCopied] = useState(false)
  const [wrapped, setWrapped] = useState(true)
  const [preview, setPreview] = useState(false)
  const text = extractText(children)
  const copy = async () => { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1200) }
  const canPreview = language === 'html' || language === 'svg'
  return <details className={styles.codeBlock} open>
    <summary>
      <span>{language || '代码'}</span>
      <span className={styles.codeTools}>
        {canPreview && <button title={preview ? '回到代码' : '渲染预览'} onClick={event => { event.preventDefault(); setPreview(value => !value) }}><Eye size={14}/></button>}
        <button title={wrapped ? '关闭换行' : '自动换行'} onClick={event => { event.preventDefault(); setWrapped(value => !value) }}><WrapText size={14}/></button>
        <button title="复制代码" onClick={event => { event.preventDefault(); void copy() }}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button>
      </span>
    </summary>
    {preview
      ? <iframe className={styles.codePreview} sandbox="" srcDoc={text} title="预览"/>
      : <pre className={wrapped ? styles.preWrap : undefined}>{children}</pre>}
  </details>
}

const STREAM_RENDER_INTERVAL = 180

// During streaming, tokens arrive far faster than a full markdown parse should
// run; render the growing text at most every STREAM_RENDER_INTERVAL ms and snap
// to the exact content once generation finishes.
export function StreamingMarkdown({ content, streaming }: { content: string; streaming: boolean }) {
  const [rendered, setRendered] = useState(content)
  const lastRender = useRef(0)
  useEffect(() => {
    if (!streaming) {
      lastRender.current = 0
      setRendered(content)
      return
    }
    const elapsed = Date.now() - lastRender.current
    if (elapsed >= STREAM_RENDER_INTERVAL) {
      lastRender.current = Date.now()
      setRendered(content)
      return
    }
    const timer = window.setTimeout(() => { lastRender.current = Date.now(); setRendered(content) }, STREAM_RENDER_INTERVAL - elapsed)
    return () => window.clearTimeout(timer)
  }, [content, streaming])
  return <Markdown>{rendered}</Markdown>
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node && typeof node === 'object' && 'props' in node) return extractText((node as { props: { children?: ReactNode } }).props.children)
  return ''
}
