import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Copy, Lock, LockOpen, Plus, Sparkles, Trash2, X, PanelRight, SlidersHorizontal, Layers } from 'lucide-react'
import { api } from '../../../api'
import { Button, Input, Select } from '../../../components/kit'
import { commit, compileNow, currentPage, editLayout, setUi, toast, useStore, useWorkState } from '../store'
import type { PromptSegment } from '../types'
import type { Asset } from '../../atelier/atelierApi'
import styles from './creative.module.css'
import { Popover, useAnchor } from '../../../components/kit'
import { useCompactWorkspace } from '../../../hooks/useCompactWorkspace'
import { SegmentedControl } from '../../../components/kit/SegmentedControl'

export function CreativeBar() {
  const state = useWorkState()
  const compact = useCompactWorkspace()
  const options = useAnchor()
  const [assets, setAssets] = useState<Asset[]>([])
  const [materials, setMaterials] = useState(false)
  const doc = state.doc
  useEffect(() => { if (materials) void Promise.all(['character', 'artist', 'lora', 'tag', 'preset', 'notebook'].map(kind => api<Asset[]>(`/api/v1/objects/${kind}`))).then(lists => setAssets(lists.flat())).catch(e => toast(String(e), 'err')) }, [materials])
  if (!doc) return null
  const view = state.workspace === 'image' ? 'image' : doc.kind
  const selectView = (value: string) => { if(compact)setUi({mobilePanel:'editor'}); if (value === 'image') setUi({ workspace: 'image' }); else { setUi({ workspace: 'edit' }); commit({ ...doc, kind: value as 'layout' | 'caption' }) } }
  const comic = () => {
    if (doc.layout.items.length && !window.confirm('添加漫画分格会保留已有图层，继续吗？')) return
    editLayout(layout => ({ ...layout, summary: { ...layout.summary, canvas: 'multi_panel' }, items: [...layout.items, ...Array.from({ length: 4 }, (_, index) => { const x = index % 2, y = Math.floor(index / 2); return { id: crypto.randomUUID(), label: 'object' as const, name: `分格 ${index + 1}`, caption: '', shape: 'rectangle' as const, bbox: [layout.width * (.03 + x * .49), layout.height * (.03 + y * .49), layout.width * (.48 + x * .49), layout.height * (.48 + y * .49)] as [number, number, number, number] } })] }))
  }
  const agentVisible = compact ? state.mobilePanel === 'agent' : state.agentOpen
  return <><div className={styles.bar}><SegmentedControl label="创作视图" className={styles.views} value={view} options={[{id:'caption',label:'文稿'},{id:'layout',label:'构图'},{id:'image',label:'出图'}]} onChange={selectView}/>
    <span className={styles.spacer}/>
    {view === 'layout' && compact && <button data-inspector-toggle aria-controls="creation-inspector" aria-label="图层与属性" aria-expanded={state.inspectorOpen && !agentVisible} onClick={()=>setUi({inspectorOpen:!state.inspectorOpen || agentVisible,mobilePanel:"editor"})}><Layers size={16}/></button>}
    <button aria-label="引用素材" title="引用素材" aria-expanded={materials} onClick={()=>setMaterials(v=>!v)} className={styles.materialButton}><Layers size={15}/><span>素材{doc.asset_ids?.length ? ` ${doc.asset_ids.length}` : ''}</span></button>
    <button ref={options.ref} aria-label="编译选项" title="编译选项" aria-expanded={options.open} onClick={options.toggle}><SlidersHorizontal size={16}/></button>
    <Popover anchor={options.ref.current} open={options.open} onClose={options.close} align="right" width={230}><div className="compile-options"><label>输出格式<select aria-label="提示词输出目标" value={doc.compile_target || 'moss'} onChange={e=>commit({...doc,compile_target:e.target.value as 'moss'|'anima'|'plain'})}><option value="moss">MOSS</option><option value="anima">Anima</option><option value="plain">普通文本</option></select></label>{view==='layout' && <button className="menu-item" onClick={()=>{options.close();comic()}}>添加漫画分格</button>}</div></Popover>
    <Button tone="primary" className={styles.compileButton} title="编译提示词" aria-label="编译提示词" disabled={state.compiling} onClick={()=>void compileNow(true)}><Sparkles size={14}/><span>{state.compiling?'编译中…':'编译'}</span></Button>
    {view!=='image' && <button data-agent-toggle aria-label={agentVisible?'收起 Agent':'与 Agent 讨论'} aria-controls="creation-agent" aria-expanded={agentVisible} className={styles.agentToggle} onClick={()=>setUi(compact?{mobilePanel:agentVisible?'editor':'agent',inspectorOpen:false}:{agentOpen:!agentVisible})}><PanelRight size={16}/><span>Agent</span></button>}
    </div><div className={styles.materialReveal} data-open={materials} inert={!materials}><div><div className={styles.materials}>{assets.map(asset => <label key={asset.id}><input type="checkbox" checked={doc.asset_ids?.includes(asset.id) || false} onChange={e => commit({ ...doc, asset_ids: e.target.checked ? [...(doc.asset_ids || []), asset.id] : doc.asset_ids?.filter(id => id !== asset.id) })} />{asset.name}<small>{{character:'角色',artist:'画师',lora:'LoRA',tag:'标签',preset:'预设',notebook:'笔记'}[asset.kind] || asset.kind}</small></label>)}{(doc.asset_ids || []).filter(id=>assets.find(a=>a.id===id)?.kind==='preset').length > 1 && <p className={styles.referenceNote}>预设按引用顺序覆盖参数；预设与笔记供 Agent 使用，不会全局套用到编译或翻译。</p>}{!assets.length && <span>暂无素材，请先到「素材」添加。</span>}<button onClick={() => setMaterials(false)}>收起</button></div></div></div></>
}

export function SegmentEditor() {
  const doc = useStore(state => state.doc)!
  const segments = doc.caption.segments || [{ id: 'initial', name: '画面', text: doc.caption.caption }]
  const [pending, setPending] = useState<{ id: string; base: string; text: string } | null>(null)
  const [busy, setBusy] = useState('')
  const [drag, setDrag] = useState('')
  const [selection,setSelection] = useState<{id:string;start:number;end:number}|null>(null)
  const write = (next: PromptSegment[], key?: string) => commit({ ...doc, caption: { caption: next.map(segment => segment.text).filter(Boolean).join('\n'), segments: next } }, key)
  const patch = (id: string, values: Partial<PromptSegment>) => write(segments.map(segment => segment.id === id ? { ...segment, ...values } : segment), `segment-${id}`)
  const move = (id: string, offset: number) => { const index = segments.findIndex(segment => segment.id === id); const next = [...segments]; if (index + offset < 0 || index + offset >= next.length) return; [next[index], next[index + offset]] = [next[index + offset], next[index]]; write(next) }
  const transform = async (segment: PromptSegment, action: string) => { setBusy(segment.id); try { const result = await api<{ text: string }>('/api/v1/text/transform', { method: 'POST', body: JSON.stringify({ text: segment.text, action }) }, 300000); const current=useStore.getState().doc; if (action === 'translate') { if (!current || (current.caption.segments?.find(s=>s.id===segment.id)?.text ?? current.caption.caption)!==segment.text) { toast('段落已更新，请重新翻译','info'); return } const latest=current.caption.segments || [{id:'initial',name:'画面',text:current.caption.caption}]; commit({...current,caption:{...current.caption,segments:latest.map(s=>s.id===segment.id?{...s,translation:result.text}:s)}}) } else setPending({ id: segment.id, base: segment.text, text: result.text }) } catch (e) { toast(String(e), 'err') } finally { setBusy('') } }
  return <section className={styles.editor}><header className={styles.editorHeader}><div><h2>{currentPage()?.name || "文稿"}</h2></div><Button onClick={() => { void navigator.clipboard.writeText(segments.map(s => s.text).join('\n')); toast('最终提示词已复制', 'ok') }}><Copy size={14} />复制提示词</Button></header>{segments.map((segment, index) => <article key={segment.id} className={styles.segment} data-locked={segment.locked} draggable onDragStart={() => setDrag(segment.id)} onDragOver={e => e.preventDefault()} onDrop={() => { if (drag === segment.id) return; const next = segments.filter(x => x.id !== drag); const moved = segments.find(x => x.id === drag); if (moved) { next.splice(index, 0, moved); write(next) } }}><div className={styles.segmentHead}><input aria-label="段落名称" value={segment.name} onChange={e => patch(segment.id, { name: e.target.value })} /><span className={styles.spacer} /><button title="上移段落" disabled={index === 0} onClick={() => move(segment.id, -1)}><ArrowUp size={13} /></button><button title="下移段落" disabled={index === segments.length - 1} onClick={() => move(segment.id, 1)}><ArrowDown size={13} /></button><button title={segment.locked ? '解除固定' : '固定段落'} onClick={() => patch(segment.id, { locked: !segment.locked })}>{segment.locked ? <Lock size={13} /> : <LockOpen size={13} />}</button><button title="删除段落" disabled={segment.locked} onClick={() => write(segments.filter(x => x.id !== segment.id))}><Trash2 size={13} /></button></div><textarea onSelect={event => { const input=event.currentTarget;setSelection(input.selectionEnd>input.selectionStart?{id:segment.id,start:input.selectionStart,end:input.selectionEnd}:null) }} aria-label={`${segment.name}内容`} readOnly={segment.locked || pending?.id === segment.id} placeholder="主体、动作、光线、镜头，或一段尚未成形的想法…" value={segment.text} onChange={e => patch(segment.id, { text: e.target.value })} /><div className={styles.segmentTools}><button disabled={segment.locked || !segment.text || !!busy} onClick={() => void transform(segment, 'polish')}>润色</button><button disabled={!segment.text || !!busy} onClick={() => void transform(segment, 'translate')}>对照翻译</button><button onClick={() => { void navigator.clipboard.writeText(segment.text); toast('段落已复制') }}>复制</button>{busy === segment.id && <span>正在处理…</span>}{segment.locked && <span>已固定，Agent 保持原文</span>}</div>{segment.translation && <p className={styles.translation}>{segment.translation}</p>}{pending?.id === segment.id && <div className={styles.proposal}><del>{pending.base}</del><ins>{pending.text}</ins><div><Button onClick={() => { const current = useStore.getState().doc?.caption.segments?.find(x => x.id === segment.id); if ((current?.text || segment.text) !== pending.base || current?.locked) { toast('段落已更新，请重新润色', 'err'); return } patch(segment.id, { text: pending.text }); setPending(null) }}><Check size={14} />采纳</Button><Button onClick={() => setPending(null)}><X size={14} />驳回</Button></div></div>}</article>)}<div className={styles.editorFooter}>{selection && <Button onClick={() => {
    const segment=segments.find(s=>s.id===selection.id);if(!segment || segment.locked)return;
    const pieces=[{...segment,text:segment.text.slice(0,selection.start),translation:undefined},{id:crypto.randomUUID(),name:segment.name+' · 固定',text:segment.text.slice(selection.start,selection.end),locked:true},{id:crypto.randomUUID(),name:segment.name+' · 续',text:segment.text.slice(selection.end)}].filter(piece=>piece.text);
    write(segments.flatMap(s=>s.id===segment.id?pieces:[s]));setSelection(null);
  }}><Lock size={14}/>固定选中文字</Button>}<Button onClick={() => write([...segments, { id: crypto.randomUUID(), name: '新段落', text: '' }])}><Plus size={14} />添加一段</Button><Button disabled={segments.some(x => x.locked)} onClick={() => write([{ id: crypto.randomUUID(), name: '成稿', text: segments.map(s => s.text).join('\n') }])}>合并成一段</Button></div></section>
}
