import { BrainCircuit, ChevronLeft, ChevronRight, Copy, FileText, Globe2, Paperclip, Radio, RefreshCw, Search, Send, Square, Trash2, Wrench, X } from 'lucide-react'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { api, ApiError, uid } from '../../api'
import { Button, Select, Switch, Textarea } from '../../components/ui'
import type { Candidate, ChatTurn, Provider, SearchSettings, ToolEvent } from '../../types'
import { activeCandidate, chatReducer, initialChatState } from './chatReducer'
import { canStartChatRequest, SseParser, stripDsml, supportsThinking } from './chatUtils'
import { Markdown } from './Markdown'
import styles from './chat.module.css'

interface Attachment { name: string; content: string; size: number }

export function ChatPage({ toast, providerRefresh = 0 }: { toast: (text: string) => void; providerRefresh?: number }) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState)
  const [providers, setProviders] = useState<Provider[]>([])
  const [providerId, setProviderId] = useState('deepseek')
  const [model, setModel] = useState('')
  const [thinking, setThinking] = useState(false)
  const [effort, setEffort] = useState<'high' | 'max'>('high')
  const [webSearch, setWebSearch] = useState(false)
  const [stream, setStream] = useState(true)
  const [searchSettings, setSearchSettings] = useState<SearchSettings | null>(null)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const controller = useRef<AbortController | null>(null)
  const conversationId = useRef(uid('conversation'))
  const fileRef = useRef<HTMLInputElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)

  const loadProviders = async () => {
    const result = await api<{ providers: Provider[] }>('/api/chat/providers')
    const enabled = result.providers.filter(provider => provider.id === 'local' || provider.enabled !== false)
    setProviders(enabled)
    setProviderId(current => enabled.some(provider => provider.id === current) ? current : (enabled.find(provider => provider.id === 'deepseek')?.id || 'local'))
    setSearchSettings(await api<SearchSettings>('/api/search/settings'))
  }
  useEffect(() => { void loadProviders() }, [providerRefresh])
  const provider = providers.find(item => item.id === providerId)
  const models = useMemo(() => providerId === 'local' ? [] : [...new Set([provider?.default_model, ...(provider?.models || [])].filter(Boolean) as string[])], [provider, providerId])
  useEffect(() => {
    if (providerId !== 'local') { setModel(models.includes(model) ? model : (provider?.default_model || models[0] || '')); return }
    api<{ data?: Array<{ id: string }> }>('/api/chat/models').then(result => { const ids = (result.data || []).map(item => item.id); setModel(current => ids.includes(current) ? current : (ids[0] || 'default')) }).catch(() => setModel('default'))
  }, [providerId, provider?.default_model, models.join('|')])
  useEffect(() => { messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' }) }, [state.turns])
  const canThink = supportsThinking(provider)
  const activeSearch = searchSettings?.providers.find(item => item.id === searchSettings.provider)

  const visibleMessages = (turnIndex: number) => {
    const messages: Array<{ role: string; content: string }> = []
    state.turns.slice(0, turnIndex).forEach(turn => {
      messages.push({ role: 'user', content: turn.user.content })
      const candidate = activeCandidate(turn)
      if (candidate) messages.push({ role: 'assistant', content: candidate.content })
    })
    messages.push({ role: 'user', content: state.turns[turnIndex].user.content })
    return messages
  }
  const parentCandidate = (turnIndex: number) => {
    if (turnIndex <= 0) return undefined
    const candidate = activeCandidate(state.turns[turnIndex - 1])
    return candidate?.provider === providerId && candidate.model === model ? candidate.backendId : undefined
  }

  const requestAssistant = async (turnIndex: number) => {
    if (controller.current) return toast('请先停止当前生成')
    const turn = state.turns[turnIndex]
    const candidateId = uid('candidate')
    const candidate: Candidate = { id: candidateId, provider: providerId, model, content: '', reasoning: '', tools: [], status: 'streaming' }
    dispatch({ type: 'add_candidate', turnId: turn.id, candidate })
    controller.current = new AbortController()
    const body = {
      provider: providerId,
      model,
      messages: visibleMessages(turnIndex),
      stream,
      event_format: 'v2',
      conversation_id: conversationId.current,
      parent_candidate_id: parentCandidate(turnIndex),
      thinking_enabled: canThink && thinking,
      reasoning_effort: effort,
      web_search_tool: webSearch,
    }
    try {
      let response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.current.signal })
      if (response.status === 410 && body.parent_candidate_id) {
        response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, parent_candidate_id: undefined }), signal: controller.current.signal })
        toast('后端上下文已重建')
      }
      if (!response.ok) { const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` })); throw new ApiError(error.error || `HTTP ${response.status}`, response.status) }
      let received = false
      if (!stream) {
        const result = await response.json()
        dispatch({ type: 'set_backend_id', turnId: turn.id, candidateId, backendId: result.candidate_id })
        if (result.content) { received = true; dispatch({ type: 'append', turnId: turn.id, candidateId, field: 'content', delta: result.content }) }
        if (result.reasoning) dispatch({ type: 'append', turnId: turn.id, candidateId, field: 'reasoning', delta: result.reasoning })
        for (const tool of result.tool_events || []) dispatch({ type: 'tool', turnId: turn.id, candidateId, event: tool })
      } else {
        const reader = response.body?.getReader(); if (!reader) throw new Error('浏览器不支持流式响应')
        const decoder = new TextDecoder(); const parser = new SseParser(); let done = false
        while (!done) {
          const part = await reader.read(); done = part.done
          const frames = parser.push(decoder.decode(part.value || new Uint8Array(), { stream: !done }), done)
          for (const raw of frames) {
            if (raw === '[DONE]') continue
            const event = JSON.parse(raw)
            if (event.type === 'start') dispatch({ type: 'set_backend_id', turnId: turn.id, candidateId, backendId: event.candidate_id })
            else if (event.type === 'content_delta') { received = true; dispatch({ type: 'append', turnId: turn.id, candidateId, field: 'content', delta: event.delta || '' }) }
            else if (event.type === 'reasoning_delta') dispatch({ type: 'append', turnId: turn.id, candidateId, field: 'reasoning', delta: event.delta || '' })
            else if (['tool_call', 'tool_result', 'tool_status', 'call', 'result', 'status', 'retry', 'limit'].includes(event.type)) dispatch({ type: 'tool', turnId: turn.id, candidateId, event: normalizeTool(event) })
            else if (event.type === 'error') throw new Error(event.message || '生成失败')
          }
        }
      }
      if (!received) dispatch({ type: 'append', turnId: turn.id, candidateId, field: 'content', delta: '(空回复)' })
      dispatch({ type: 'finish', turnId: turn.id, candidateId, status: 'done' })
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') dispatch({ type: 'finish', turnId: turn.id, candidateId, status: 'stopped' })
      else dispatch({ type: 'finish', turnId: turn.id, candidateId, status: 'error', error: reason instanceof Error ? reason.message : String(reason) })
    } finally { controller.current = null }
  }

  useEffect(() => {
    const index = state.turns.length - 1
    const last = state.turns[index]
    if (last && last.candidates.length === 0 && !state.generating && !controller.current) void requestAssistant(index)
  }, [state.turns.length])

  const send = async () => {
    if (!canStartChatRequest(input, attachments.length, Boolean(controller.current))) {
      if (controller.current) toast('当前回答仍在生成')
      return
    }
    const context = attachments.map(file => `--- 文件: ${file.name} ---\n${file.content}`).join('\n\n')
    const content = `${input.trim() || '请阅读附件内容。'}${context ? `\n\n[用户导入的文件上下文]\n${context}` : ''}`
    const turn: ChatTurn = { id: uid('turn'), user: { content, display: input.trim() || '(附件)' }, candidates: [], activeCandidateId: '' }
    dispatch({ type: 'add_turn', turn }); setInput(''); setAttachments([])
  }
  const stop = () => controller.current?.abort()
  const clear = async () => { controller.current?.abort(); await api(`/api/chat/conversations/${encodeURIComponent(conversationId.current)}`, { method: 'DELETE' }).catch(() => {}); conversationId.current = uid('conversation'); dispatch({ type: 'clear' }); setAttachments([]) }
  const files = async (list: FileList | null) => { if (!list) return; const next: Attachment[] = []; for (const file of Array.from(list)) { if (file.size > 1024 * 1024) { toast(`文件过大：${file.name}`); continue } next.push({ name: file.name, size: file.size, content: (await file.text()).slice(0, 20000) }) } setAttachments(current => [...current, ...next]) }

  return <div className={styles.chat}>
    <div className={styles.toolbar}>
      <Select value={providerId} onChange={event => setProviderId(event.target.value)}>{providers.map(item => <option key={item.id} value={item.id}>{item.name}{item.api_key_set === false ? ' · 未配置' : ''}</option>)}</Select>
      <Select value={model} onChange={event => setModel(event.target.value)}>{(models.length ? models : [model || 'default']).map(item => <option key={item}>{item}</option>)}</Select>
      <Select value={effort} disabled={!canThink} onChange={event => setEffort(event.target.value as 'high' | 'max')}><option value="high">High</option><option value="max">Max</option></Select>
      <Switch checked={thinking} disabled={!canThink} onChange={setThinking} label={<><BrainCircuit size={14}/>思考</>}/>
      <Switch checked={webSearch} disabled={!activeSearch?.configured} onChange={setWebSearch} label={<><Search size={14}/>Web Search</>}/>
      <Switch checked={stream} onChange={setStream} label={<><Radio size={14}/>流式</>}/>
      <span style={{ marginLeft: 'auto', color: 'var(--text-3)', fontSize: 11 }}>{activeSearch?.configured ? `${activeSearch.name} 已就绪` : `缺少 ${activeSearch?.env_var || '搜索 Key'}`}</span>
      <Button iconOnly title="清空对话" onClick={() => void clear()}><Trash2 size={15}/></Button>
    </div>
    <div className={styles.messages} ref={messagesRef}>
      {!state.turns.length && <div className={styles.empty}><div><Globe2 size={26}/><p>选择模型后开始对话</p><small>模型会在需要当前信息时自行调用 Web Search</small></div></div>}
      {state.turns.map((turn, turnIndex) => {
        const candidate = activeCandidate(turn); const index = candidate ? turn.candidates.findIndex(item => item.id === candidate.id) : -1
        return <div key={turn.id} className={styles.turn}><div className={styles.user}>{turn.user.display}</div>{candidate && <article className={styles.assistant} data-streaming={candidate.status === 'streaming'}>
          <div className={styles.assistantBody}>
            {candidate.tools.length > 0 && <details className={styles.tools} open={candidate.status === 'streaming'}><summary><Wrench size={14}/>工具调用</summary><div>{candidate.tools.map((tool, i) => <div className={styles.toolRow} key={`${tool.type}-${i}`}><strong>{tool.type === 'call' ? '调用' : tool.type === 'result' ? '结果' : '状态'}</strong><span>{tool.query || tool.summary || tool.message || tool.name}</span></div>)}</div></details>}
            {candidate.reasoning && <details className={styles.reasoning}><summary><BrainCircuit size={14}/>思考过程</summary><div><Markdown>{stripDsml(candidate.reasoning)}</Markdown></div></details>}
            <Markdown>{candidate.content || (candidate.status === 'streaming' ? '生成中…' : '(空回复)')}</Markdown>{candidate.status === 'streaming' && <span className={styles.cursor}/>} {candidate.error && <div className={styles.error}>{candidate.error}</div>}
          </div>
          <div className={styles.actions}><Button size="small" onClick={() => { void navigator.clipboard.writeText(candidate.content); toast('回答已复制') }}><Copy size={13}/>复制</Button><Button size="small" disabled={!!state.generating} onClick={() => void requestAssistant(turnIndex)}><RefreshCw size={13}/>刷新</Button><Button size="small" iconOnly title="上一个回答" disabled={index <= 0} onClick={() => dispatch({ type: 'select', turnId: turn.id, candidateId: turn.candidates[index - 1].id })}><ChevronLeft size={14}/></Button><span className={styles.counter}>{index + 1}/{turn.candidates.length}</span><Button size="small" iconOnly title="下一个回答" disabled={index >= turn.candidates.length - 1} onClick={() => dispatch({ type: 'select', turnId: turn.id, candidateId: turn.candidates[index + 1].id })}><ChevronRight size={14}/></Button></div>
        </article>}</div>
      })}
    </div>
    <div className={styles.composer}>
      {attachments.length > 0 && <div className={styles.attachments}>{attachments.map((file, index) => <span className={styles.attachment} key={`${file.name}-${index}`}><FileText size={13}/>{file.name}<button onClick={() => setAttachments(items => items.filter((_, i) => i !== index))}><X size={12}/></button></span>)}</div>}
      <div className={styles.composeRow}><Button iconOnly title="导入文本文件" onClick={() => fileRef.current?.click()}><Paperclip size={16}/></Button><Textarea value={input} placeholder="输入消息，Enter 发送，Shift+Enter 换行" onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (controller.current) toast('请先停止当前生成'); else void send() } }}/><Button tone={state.generating ? 'danger' : 'primary'} onClick={state.generating ? stop : () => void send()}>{state.generating ? <><Square size={15}/>停止</> : <><Send size={15}/>发送</>}</Button></div>
      <input ref={fileRef} hidden type="file" multiple onChange={event => { void files(event.target.files); event.target.value = '' }}/>
    </div>
  </div>
}

function normalizeTool(event: Record<string, unknown>): ToolEvent {
  const rawType = String(event.type || 'status')
  const type = rawType.includes('call') ? 'call' : rawType.includes('result') ? 'result' : rawType === 'retry' ? 'retry' : rawType === 'limit' ? 'limit' : 'status'
  return { type, name: String(event.name || ''), query: String(event.query || ''), message: String(event.message || ''), summary: String(event.summary || ''), limit: event.limit as string | number | undefined }
}
