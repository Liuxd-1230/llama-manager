import { Check, Copy } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import styles from './chat.module.css'

export function Markdown({ children }: { children: string }) {
  return <div className={styles.markdown}><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeSanitize, rehypeKatex]} components={{
    a: props => <a {...props} target="_blank" rel="noreferrer" />,
    pre: props => <CodeBlock>{props.children}</CodeBlock>,
  }}>{children}</ReactMarkdown></div>
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const text = extractText(children)
  const copy = async () => { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1200) }
  return <details className={styles.codeBlock} open><summary><span>代码</span><button onClick={event => { event.preventDefault(); void copy() }} title="复制代码">{copied ? <Check size={14}/> : <Copy size={14}/>}</button></summary><pre>{children}</pre></details>
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node && typeof node === 'object' && 'props' in node) return extractText((node as { props: { children?: ReactNode } }).props.children)
  return ''
}
