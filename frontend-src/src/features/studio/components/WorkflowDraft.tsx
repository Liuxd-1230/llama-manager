import { useMemo } from 'react'
import { Field, Input, Select } from '../../../components/kit'

export function WorkflowDraft({ raw, onChange, catalog }: { raw: string; onChange: (raw: string) => void; catalog: Record<string,string[]> }) {
  const draft = useMemo(()=>{
    if (!raw.trim()) return null
    try {
      const parsed=JSON.parse(raw)
      const nodes=parsed.prompt || parsed
      if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return {error:'请选择 API 格式的工作流 JSON'}
      const entries=Object.entries(nodes).filter(([,node])=>(node as any)?.class_type)
      const files=entries.flatMap(([id,node])=>Object.entries((node as any).inputs || {}).filter(([key,value])=>typeof value==='string' && /^(unet_name|clip_name|vae_name|ckpt_name|lora_name)$/.test(key)).map(([key,value])=>({id,key,value:String(value),type:String((node as any).class_type)})))
      return {parsed,nodes,entries,files}
    } catch {return {error:'JSON 尚未完整，请检查后保存'}}
  },[raw])
  return <div className="workflow-draft">
    {draft && ('error' in draft ? <p className="hint" role="status">{draft.error}</p> : <>
      <div className="workflow-draft-summary"><strong>待保存的工作流</strong><span>{draft.entries!.length} 个节点 · {draft.files!.length} 个模型引用</span></div>
      {draft.files!.map(file=>{
        const options=catalog[`${file.type}.${file.key}`] || []
        const update=(value:string)=>{const next=structuredClone(draft.parsed);const nodes=next.prompt || next;nodes[file.id].inputs[file.key]=value;onChange(JSON.stringify(next,null,2))}
        return <Field key={file.id+file.key} label={`${file.type} · ${file.key}`}>{options.length ? <Select value={file.value} onChange={e=>update(e.target.value)}>{!options.includes(file.value) && <option value={file.value}>{file.value}（服务未提供）</option>}{options.map(value=><option key={value}>{value}</option>)}</Select> : <Input value={file.value} onChange={e=>update(e.target.value)}/>}</Field>
      })}
      <p className="hint">{Object.keys(catalog).length ? '模型列表来自当前 ComfyUI。请核对节点与模型，执行时仍由服务校验。' : 'ComfyUI 尚未提供模型清单。可先保存工作流，连接后核对这些文件名；当前仅检查 JSON 与参数绑定。'}</p>
    </>)}
    <details open={!draft || 'error' in draft}><summary>高级 JSON 编辑</summary><textarea aria-label="工作流 JSON" className="textarea mono" rows={4} placeholder="从 ComfyUI 导出 API 格式，粘贴到这里…" value={raw} onChange={e=>onChange(e.target.value)}/></details>
  </div>
}
