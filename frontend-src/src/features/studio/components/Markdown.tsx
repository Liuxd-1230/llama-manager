import { memo } from 'react'
import { Markdown as ConversationMarkdown, StreamingMarkdown } from '../../chat/Markdown'

// Preserve Agent props while sharing the conversation renderer and code controls.
export const Markdown = memo(function Markdown({ text, caret }: { text: string; caret?: boolean }) {
  // Keep the original Agent's prose-fence handling; JSON/code remains code.
  const content=text.replace(/```([^\n]*)\n([\s\S]*?)```/g,(fence,language:string,body:string)=>{
    const lang=language.trim().toLowerCase()
    if(lang==='markdown'||lang==='md')return body
    if(lang && !['text','txt','plain','plaintext'].includes(lang))return fence
    if(body.split('\n').some(line=>/^\s*[{[]/.test(line)))return fence
    const compact=body.replace(/\s+/g,'')
    return compact && (compact.match(/[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/g)||[]).length/compact.length>=.2 ? body : fence
  })
  return <div className="md">{caret ? <StreamingMarkdown content={content} streaming /> : <ConversationMarkdown>{content}</ConversationMarkdown>}{caret && <span className="caret" />}</div>
})
