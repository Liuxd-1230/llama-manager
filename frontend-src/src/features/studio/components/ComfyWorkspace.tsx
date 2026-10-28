import { WorkflowDraft } from "./WorkflowDraft";
import { useQuery } from "@tanstack/react-query";
import { JobList } from "../../atelier/Jobs";
import type { Job } from "../../atelier/atelierApi";
import { commit } from "../store";
import { Check, Download, Loader2, Play, RefreshCw, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { api as api2 } from "../../../api";
import { toast, useStore } from "../store";
import { Button, Field, Input, Select } from "../../../components/kit";
import type { CompileResult } from "../types";
import { FolioGlyph } from "../../../components/AtelierBrand";
import { SegmentedControl } from "../../../components/kit/SegmentedControl";
import { ComfyGraphView, type ComfyGraph } from "./ComfyGraphView";

interface ComfyStatus {
  url: string;
  reachable: boolean;
  has_workflow: boolean;
  bindings: Record<string, { node: string; input: string }>;
  fields: Record<string, string>;
  nodes: { node: string; class_type: string; title: string; inputs: { name: string; type: string; is_link: boolean; value: string | number | boolean | null }[] }[];
  binding_errors: string[];
  workflows: { id: string; name: string; nodes: number; bindings: number; active: boolean }[];
  active_id: string;
  active_name: string;
  params?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  graph?: ComfyGraph;
}
type Bindings = Record<string, { node: string; input: string }>;

/** Image workspace: same level as Layout/Caption, not a modal. */
export function ComfyWorkspace() {
  const doc = useStore((s) => s.doc);
  const pageId = useStore((s) => s.pageId);
  const compileResult = useStore((s) => s.compileResult);
  const compileStale = useStore((s) => s.compileStale);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [bindings, setBindings] = useState<Bindings>({});
  const [status, setStatus] = useState<ComfyStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [bindingErrors, setBindingErrors] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [raw, setRaw] = useState("");
  const [graph, setGraph] = useState<ComfyGraph>({ nodes: [], edges: [] });
  const [positive, setPositive] = useState("");
  const [promptSource, setPromptSource] = useState<CompileResult | null>(null);
  const [negative, setNegative] = useState("");
  const [seed, setSeed] = useState(-1);
  const [width, setWidth] = useState(doc?.layout.width ?? 1024);
  const [height, setHeight] = useState(doc?.layout.height ?? 1536);
  const [cfg, setCfg] = useState(7);
  const [sampler, setSampler] = useState("euler");
  const [scheduler, setScheduler] = useState("normal");
  const [steps, setSteps] = useState(20);
  const [workflows, setWorkflows] = useState<{ id: string; name: string; nodes: number; bindings: number; active: boolean }[]>([]);
  const [activeId, setActiveId] = useState("");
  const [workflowName, setWorkflowName] = useState("");
  const [choices, setChoices] = useState<{ samplers: string[]; schedulers: string[]; models?: Record<string,string[]> }>({ samplers: [], schedulers: [] });
  const generations = useQuery({ queryKey:['atelier-jobs','generation',pageId], queryFn:()=>api2<Job[]>(`/api/v1/jobs?kind=generation&page_id=${encodeURIComponent(pageId)}&limit=500`), refetchInterval:2500 });
  const [comparison,setComparison] = useState<string[]>([]);
  const [loraNodes,setLoraNodes] = useState<Record<string,string>>({});
  const [loraWeights,setLoraWeights] = useState<Record<string,number>>({});
  const [referencedLoras,setReferencedLoras] = useState<any[]>([]);
  useEffect(()=> {
    if (promptSource?.asset_snapshot) { setReferencedLoras(promptSource.asset_snapshot.filter(asset=>asset.kind==='lora')); return }
    void api2<any[]>('/api/v1/objects/lora').then(all=>setReferencedLoras(all.filter(asset=>doc?.asset_ids?.includes(asset.id)))).catch(()=>undefined)
  },[doc?.asset_ids,promptSource]);
  const [showGraph, setShowGraph] = useState(false);
  const generationJobs = (generations.data || []).filter(job => job.kind === "generation" && job.data.page_id === pageId);
  const [focusNode, setFocusNode] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const restoringStatus = useRef(false);
  const activeWorkflow = useRef("");
  const paramsReady = useRef(false);

  const applyStatus = useCallback((s: ComfyStatus, restore: boolean) => {
    setStatus(s);
    setLabels(s.fields || {});
    if (restore || activeWorkflow.current !== s.active_id) setUrl(s.url);
    setBindingErrors(s.binding_errors || []);
    setWorkflows(s.workflows || []);
    setActiveId(s.active_id || "");
    const changed = activeWorkflow.current !== (s.active_id || "");
    if (restore || changed) { setBindings(s.bindings || {}); setDirty(false); setFocusNode(null); setLoraNodes({}); }
    activeWorkflow.current = s.active_id || "";
    // Prompts are NOT restored from the last run: they come from the current
    // compile result (seeded below). Restoring them would silently resurrect a
    // stale prompt from a previous page.
    const p = (s as { params?: Record<string, unknown> }).params || {};
    if (!restore && !changed) return;
    paramsReady.current = Boolean(s.active_id);
    if (typeof p.seed === "number") setSeed(p.seed);
    if (typeof p.width === "number") setWidth(p.width);
    if (typeof p.height === "number") setHeight(p.height);
    if (typeof p.cfg === "number") setCfg(p.cfg);
    if (typeof p.sampler === "string") setSampler(p.sampler);
    if (typeof p.scheduler === "string") setScheduler(p.scheduler);
    if (typeof p.steps === "number") setSteps(p.steps);
  }, []);

  const loadStatus = useCallback(async (restore = true) => {
    // A periodic connectivity poll must not supersede an explicit restore.
    if (!restore && restoringStatus.current) return;
    if (restore) restoringStatus.current = true;
    const sequence = ++loadSequence.current;
    try {
      const s = await api.comfyStatus();
      if (sequence !== loadSequence.current) return;
      setStatusError("");
      const shouldRestore = restore || activeWorkflow.current !== s.active_id;
      applyStatus(s, restore);
      if (shouldRestore) setGraph(s.graph || { nodes: [], edges: [] });
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      if (restore && sequence === loadSequence.current) restoringStatus.current = false;
    }
  }, [applyStatus]);

  useEffect(() => { void loadStatus() }, [loadStatus]);

  // The compiled prompt is what this workspace exists to send. Seed the fields
  // from it so "compile → switch to 出图 → generate" actually carries the text.
  const seeded = useRef("");
  useEffect(() => {
    const prompt = compileResult?.prompt?.trim();
    if (!prompt || seeded.current === prompt) return;
    seeded.current = prompt;
    setPositive(prompt);
    setPromptSource(compileResult);
    if (compileResult?.negative) setNegative(compileResult.negative);
  }, [compileResult]);

  // Sampler/scheduler domains come from ComfyUI itself (values it accepts).
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const c = await api.comfyChoices();
        if (!alive) return;
        setChoices(c);
        if (c.samplers.length && !c.samplers.includes(sampler)) setSampler(c.samplers[0]);
        if (c.schedulers.length && !c.schedulers.includes(scheduler)) setScheduler(c.schedulers[0]);
      } catch { /* offline: keep free text */ }
    };
    void load();
    return () => { alive = false };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => { void loadStatus(false) }, 5000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  const switchWorkflow = async (id: string) => {
    if (!id || id === activeId) return;
    setBusy("switch");
    try {
      window.clearTimeout(saveParams.current);
      await api.comfyParams({ seed, width, height, cfg, sampler, scheduler, steps, workflow_id: activeId });
      paramsReady.current = false;
      ++loadSequence.current;
      const r = await api.comfyActivate(id);
      setWorkflows(r.workflows);
      setActiveId(r.active_id);
      // Prompts deliberately survive the switch: the compiled text belongs to
      // the page, and a new pipeline usually consumes the same prompt.
      await loadStatus(true);
      const name = r.workflows.find((w) => w.id === id)?.name || id;
      toast(`已切换到 ${name}，提示词已保留`, "ok");
    } catch (error) {
      toast(`切换失败：${error instanceof Error ? error.message : String(error)}`, "err");
    } finally { setBusy(""); }
  };

  const renameWorkflow = async (id: string, current: string) => {
    const name = window.prompt("工作流名称", current);
    if (!name?.trim()) return;
    try {
      const r = await api.comfyRenameWorkflow(id, name.trim());
      setWorkflows(r.workflows);
      toast("已重命名", "ok");
    } catch (error) {
      toast(`重命名失败：${error instanceof Error ? error.message : String(error)}`, "err");
    }
  };

  const deleteWorkflow = async (id: string, name: string) => {
    if (!window.confirm(`删除工作流 ${name}？节点、绑定和布局都会移除。`)) return;
    try {
      const r = await api.comfyDeleteWorkflow(id);
      setWorkflows(r.workflows);
      setActiveId(r.active_id);
      await loadStatus(true);
      toast("已删除", "ok");
    } catch (error) {
      toast(`删除失败：${error instanceof Error ? error.message : String(error)}`, "err");
    }
  };

  const persist = useCallback(async (next: Bindings, workflowId: string) => {
    setBusy("bind");
    try {
      await api.comfyBindings(next, workflowId);
      setDirty(false);
      setBindingErrors([]);
    } catch (error) {
      toast(`绑定保存失败：${error instanceof Error ? error.message : String(error)}`, "err");
    } finally { setBusy(""); }
  }, []);

  const changeBinding = (next: Bindings) => {
    setBindings(next);
    setDirty(true);
    void persist(next, activeId);
  };

  const importWorkflow = async () => {
    if (!raw.trim()) { toast("先选择或粘贴 API 格式的 workflow", "err"); return }
    setBusy("import");
    try {
      const r = await api.comfyImport(raw, workflowName.trim() || undefined);
      setLabels(r.fields);
      setWorkflows(r.workflows);
      setActiveId(r.id);
      setWorkflowName("");
      const suggested = r.suggested || {};
      setBindings(suggested);
      await api.comfyBindings(suggested, r.id);
      setDirty(false);
      toast(`已保存 ${r.nodes.length} 个节点，绑定已验证`, "ok");
      setRaw("");
      await loadStatus(true);
    } catch (error) {
      toast(`导入失败：${error instanceof Error ? error.message : String(error)}`, "err");
    } finally { setBusy(""); }
  };

  const saveUrl = async () => {
    setBusy("url");
    try {
      const r = await api.comfyUrl(url);
      setUrl(r.url);
      await loadStatus(false);
      toast(`ComfyUI 地址已设为 ${r.url}`, "ok");
    } catch (error) {
      toast(`保存地址失败：${error instanceof Error ? error.message : String(error)}`, "err");
    } finally { setBusy(""); }
  };

  const saveParams = useRef(0);
  useEffect(() => {
    if (!paramsReady.current || !activeId || busy === "switch") return;
    window.clearTimeout(saveParams.current);
    saveParams.current = window.setTimeout(() => {
      void api.comfyParams({ seed, width, height, cfg, sampler, scheduler, steps, workflow_id: activeId }).catch(error => toast(`参数保存失败：${String(error)}`, "err"));
    }, 700);
    return () => window.clearTimeout(saveParams.current);
  }, [activeId, seed, width, height, cfg, sampler, scheduler, steps, busy]);

  const generate = async () => {
    setBusy('gen');
    try {
      const [server,resources] = await Promise.all([api2<{state:string;profile?:string}>('/api/v1/server/status'),api2<any>('/api/v1/host/resources').catch(()=>null)]);
      if (server.state === 'running') {
        const reading=resources?.gpu ? `当前显存 ${(resources.gpu.used_mib/1024).toFixed(1)} / ${(resources.gpu.total_mib/1024).toFixed(1)} GB。` : '';
        if (!window.confirm(`${reading}本地档案「${server.profile || '当前档案'}」正在运行。是否暂停该引擎，为 ComfyUI 释放显存？取消后不提交出图。`)) return;
        await api2('/api/v1/server/suspend',{method:'POST'});
        toast('已暂停受管引擎。出图结束后可在顶部手动恢复。','info');
      }
      const loras=referencedLoras.map(asset=>({filename:asset.data.filename,weight:loraWeights[asset.id] ?? asset.data.weight ?? .8,node:loraNodes[asset.id]}));
      if(loras.some(lora=>!lora.node)) throw new Error('请先为每个引用的 LoRA 选择工作流节点');
      await api2('/api/v1/generations',{method:'POST',body:JSON.stringify({workflow_id:activeId,positive,negative,seed:seed<0?Math.floor(Math.random()*2**32):seed,width,height,cfg,sampler,scheduler,steps,page_id:useStore.getState().pageId,doc:promptSource?.source_doc || doc,source_hash:promptSource?.source_hash || "",asset_snapshot:promptSource?.asset_snapshot || [],loras,lora_bindings:loras})});
      await generations.refetch();
      toast('已提交出图，切换页面后任务仍会继续','ok');
    } catch(error) { toast(`生成失败：${error instanceof Error ? error.message : String(error)}`,'err'); }
    finally { setBusy(''); }
  };

  const connected = status?.reachable === true;
  const canGenerate = connected && Boolean(status?.has_workflow) && Boolean(bindings.positive) && busy === "" && !dirty && bindingErrors.length === 0;
  const boundCount = Object.keys(bindings).length;

  return (
    <div className="image-ws">
      <header className="image-ws-head">
        <Select aria-label="当前工作流" value={activeId} disabled={!workflows.length || busy !== ""}
          onChange={(e) => void switchWorkflow(e.target.value)}>
          {!workflows.length && <option value="">（还没有工作流）</option>}
          {workflows.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.nodes} 节点</option>)}
        </Select>
        {activeId && <>
          <Button size="small" title="重命名当前工作流"
            onClick={() => { const cur = workflows.find((w) => w.id === activeId); if (cur) void renameWorkflow(cur.id, cur.name); }}>改名</Button>
          <Button size="small" title="删除当前工作流"
            onClick={() => { const cur = workflows.find((w) => w.id === activeId); if (cur) void deleteWorkflow(cur.id, cur.name); }}>删除</Button>
        </>}
        <Button size="small" onClick={async()=>{try{const preset=await api2<{nodes:Record<string,unknown>}>('/api/v1/workflows/anima');setRaw(JSON.stringify(preset.nodes,null,2));setWorkflowName('Anima · 标准');toast('已填入 Anima 预设，请核对模型文件名后保存','info')}catch(error){toast(String(error),'err')}}}>Anima 预设</Button>
        <span className="comfy-state" data-state={connected ? "ok" : status ? "bad" : "unknown"}>
          <i />{connected ? `已连接 ${status?.url}` : status ? `连不上 ${status?.url}` : statusError ? `状态不可用：${statusError}` : "检测中…"}
        </span>
        <span className="image-ws-meta">{graph.nodes.length} 节点 · {boundCount} 通配</span>
        {compileResult && <span className="image-ws-meta" data-stale={compileStale || undefined}>
          {compileStale ? "提示词已过期（页面有改动，请重新编译）" : `已带入编译结果 · ${compileResult.prompt.length} 字符`}
        </span>}
        <div className="image-ws-chips" hidden={!showGraph}>
          {Object.entries(bindings).map(([field, binding]) => {
            const node = graph.nodes.find((n) => n.id === binding.node);
            return <button key={field} type="button" className="image-ws-chip" title={`${labels[field] || field} → ${node?.title || binding.node}.${binding.input}（点击定位节点）`}
              onClick={() => { setShowGraph(true); setFocusNode(binding.node) }}>
              <b>{labels[field] || field}</b>
              <span>{node?.title || `#${binding.node}`}.{binding.input}</span>
            </button>;
          })}
          {boundCount === 0 && <span className="hint">还没有通配符：点击节点后在右侧绑定</span>}
        </div>
        <div className="spacer" />
        <Button size="small" onClick={() => void loadStatus(false)}><RefreshCw size={13}/>刷新</Button>
        <Button size="small" tone="primary" disabled={!canGenerate}
          title={!connected ? "ComfyUI 未连接" : !status?.has_workflow ? "还没有导入 workflow" : dirty ? "绑定正在保存…" : bindingErrors.length ? "绑定已失效" : undefined}
          onClick={() => void generate()}>{busy === "gen" ? <Loader2 size={13} className="spin"/> : <Play size={13}/>}生成</Button>
      </header>

      <div className="image-ws-body">
        <section className="image-ws-col image-ws-setup">
          <details className="image-connection" open={!status?.has_workflow || !!raw}><summary><Upload size={13}/>连接与工作流</summary>
          <div className="row" style={{ gap: 6 }}>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:8188" aria-label="ComfyUI 地址" />
            <Button size="small" disabled={busy !== ""} onClick={() => void saveUrl()}>{busy === "url" ? "…" : "保存并测试"}</Button>
          </div>
          <WorkflowDraft raw={raw} onChange={setRaw} catalog={choices.models || {}}/>
          <div className="row" style={{ gap: 6 }}>
            <label className="btn btn-sm">
              <Upload size={13}/>选择 JSON
              <input type="file" accept=".json,application/json" hidden onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setRaw(await file.text());
                toast(`已读取 ${file.name}`, "ok");
              }} />
            </label>
            <Input value={workflowName} onChange={(e) => setWorkflowName(e.target.value)} placeholder="工作流名称（可选）" aria-label="新工作流名称" />
            <Button size="small" disabled={busy !== ""} onClick={() => void importWorkflow()}>{busy === "import" ? "解析中…" : "保存为新工作流"}</Button>
            {dirty ? <span className="hint" data-state="pending">绑定未保存…</span> : <span className="hint" data-state="ok"><Check size={11}/>绑定已同步</span>}
          </div>

          </details>

          {status && !connected && <div className="comfy-error" role="status">无法连接 ComfyUI。工作流和文稿已保留，检查地址并点击「保存并测试」。</div>}
          {bindingErrors.length > 0 && <div className="comfy-error" role="alert">
            <X size={12}/>{bindingErrors[0]}{bindingErrors.length > 1 ? `（另有 ${bindingErrors.length - 1} 项）` : ""}
          </div>}

          <div className="group-title" style={{ marginTop: 10 }}><Play size={13}/>本次参数{status?.overrides && Object.keys(status.overrides).length>0 ? " · 含保存的覆盖值" : " · 工作流默认值"}</div>
          <Field label="正向提示词"><textarea className="textarea" rows={3} value={positive} onChange={(e) => { setPositive(e.target.value); setPromptSource(null) }} placeholder="留空则沿用 workflow 自带的提示词" /></Field>
          <Field label="负向提示词"><textarea className="textarea" rows={2} value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="留空则沿用 workflow 自带的提示词" /></Field>
          <div className="row">
            <Field label="宽度"><Input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} /></Field>
            <Field label="高度"><Input type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} /></Field>
            <Field label="种子 (-1 随机)"><Input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} /></Field>
          </div>
          <div className="row">
            <Field label="CFG"><Input type="number" step="0.1" value={cfg} onChange={(e) => setCfg(Number(e.target.value))} /></Field>
            <Field label="步数"><Input type="number" value={steps} onChange={(e) => setSteps(Number(e.target.value))} /></Field>
          </div>
          <div className="row">
            <Field label={`采样器${choices.samplers.length ? `（${choices.samplers.length}）` : ""}`}>
              {choices.samplers.length
                ? <Select value={sampler} onChange={(e) => setSampler(e.target.value)}>{choices.samplers.map((v) => <option key={v} value={v}>{v}</option>)}</Select>
                : <Input value={sampler} onChange={(e) => setSampler(e.target.value)} placeholder="连上 ComfyUI 后可选择" />}
            </Field>
            <Field label={`调度器${choices.schedulers.length ? `（${choices.schedulers.length}）` : ""}`}>
              {choices.schedulers.length
                ? <Select value={scheduler} onChange={(e) => setScheduler(e.target.value)}>{choices.schedulers.map((v) => <option key={v} value={v}>{v}</option>)}</Select>
                : <Input value={scheduler} onChange={(e) => setScheduler(e.target.value)} placeholder="连上 ComfyUI 后可选择" />}
            </Field>
          </div>
          <div className="hint">参数默认来自当前工作流节点；修改仅覆盖这份工作流。提示词仍来自当前文稿。</div>

          {referencedLoras.map(asset=><div className="field" key={asset.id}><label>{asset.name} · 权重 {(loraWeights[asset.id] ?? asset.data.weight ?? .8).toFixed(2)}</label><input aria-label={`${asset.name} 权重`} type="range" min=".1" max="1.5" step=".05" value={loraWeights[asset.id] ?? asset.data.weight ?? .8} onChange={e=>setLoraWeights({...loraWeights,[asset.id]:Number(e.target.value)})}/><Select value={loraNodes[asset.id] || ''} onChange={e=>setLoraNodes({...loraNodes,[asset.id]:e.target.value})}><option value="">选择 LoRA 节点</option>{graph.nodes.filter(node=>node.class_type==='LoraLoader').map(node=><option key={node.id} value={node.id}>{node.title || node.id}</option>)}</Select></div>)}
          <Button size="small" disabled={!activeId || !!busy} onClick={async () => {
            // A pending debounced edit must not overwrite the explicit reset.
            window.clearTimeout(saveParams.current);
            paramsReady.current = false;
            setBusy('reset');
            try { await api.comfyParams({workflow_id:activeId,reset:true}); await loadStatus(true); toast("已恢复工作流节点默认值", "ok") }
            catch(error) { toast(`恢复失败：${error instanceof Error ? error.message : String(error)}`, 'err'); paramsReady.current = true }
            finally { setBusy('') }
          }}>恢复节点默认值</Button><div className="group-title">生成记录</div>
          <JobList jobs={generationJobs.slice(0,5)} toast={message=>toast(message)}/>


        </section>

        <section className="image-ws-col image-ws-graph">
          <div className="image-view-tabs"><SegmentedControl label="出图面板" value={showGraph ? 'graph' : 'results'} options={[{id:'results',label:'结果预览'},{id:'graph',label:'工作流节点'}]} onChange={value => setShowGraph(value === 'graph')}/><span className="hint">{showGraph ? "选择节点以配置参数绑定" : "提示词与参数随每次生成单独保存"}</span></div>
          {showGraph ? <ComfyGraphView key={activeId}
            graph={graph}
            bindings={bindings}
            fieldLabels={labels}
            focusNode={focusNode}
            onBind={(field, binding) => {
              const next = { ...bindings };
              if (binding) next[field] = binding; else delete next[field];
              changeBinding(next);
            }}
            onLayout={(positions) => void api.comfyLayout(positions, activeId).catch(() => undefined)}
          /> : <div className="image-results" aria-label="生成结果">
          {!generationJobs.some(job => job.result.images?.length) && <div className="image-results-empty"><FolioGlyph/><h2>让画面在这里成形</h2><p>{generationJobs.some(job => job.status === 'running' || job.status === 'queued') ? '正在生成。你可以继续改稿，当前任务使用提交时的快照。' : '编译提示词，检查参数，然后生成第一幅作品。'}</p><button type="button" className="btn" onClick={() => setShowGraph(true)}>查看工作流节点</button></div>}
          <div className="generation-gallery" data-single={generationJobs.reduce((count,job)=>count+(job.result.images?.length || 0),0)===1 || undefined}>{generationJobs.flatMap(job=>(job.result.images || []).map((image:any)=><article key={image.url}><img src={image.url} alt={image.filename}/><div className="generation-caption"><span>种子 {job.data.seed} · {job.data.width} × {job.data.height}</span><span>{job.data.steps} 步</span></div><label><input type="checkbox" checked={comparison.includes(image.url)} onChange={e=>setComparison(e.target.checked?[...comparison,image.url]:comparison.filter(url=>url!==image.url))}/>比较</label><div className="row"><a className="btn btn-sm" href={image.url} download={image.filename}>下载</a><Button size="small" onClick={async()=>{await api2('/api/v1/objects/artwork',{method:'POST',body:JSON.stringify({name:image.filename,data:{url:image.url,snapshot:job.data}})});toast('已保存到作品库','ok')}}>收藏</Button><Button size="small" onClick={async()=>{try {
            const restored=await api2<{snapshot:Job['data']}>(`/api/v1/generations/${job.id}/restore`,{method:'POST'});
            await loadStatus(true);const d=restored.snapshot;
            setPromptSource({prompt:d.positive,checks:[],prefix:"",negative:d.negative,source_doc:d.doc,source_hash:d.source_hash,asset_snapshot:d.asset_snapshot});
            setPositive(d.positive);setNegative(d.negative);setSeed(d.seed);setSteps(d.steps);setCfg(d.cfg);setWidth(d.width);setHeight(d.height);setSampler(d.sampler || 'euler');setScheduler(d.scheduler || 'normal');
            const nodes:Record<string,string>={};const weights:Record<string,number>={};
            for(const asset of d.asset_snapshot || []) { const binding=(d.lora_bindings || []).find((lora:any)=>lora.filename===asset.data?.filename);if(binding){nodes[asset.id]=binding.node;weights[asset.id]=binding.weight} }
            setLoraNodes(nodes);setLoraWeights(weights);if(d.doc)commit(d.doc);toast('已恢复文稿、全部参数和独立的工作流副本','ok');
          }catch(error){toast(String(error),'err')}}}>再编辑</Button></div></article>))}</div>
          {comparison.length>0 && <div className="comparison-gallery">{comparison.map(url=><img key={url} src={url} alt="选中比较的生成结果"/>)}</div>}
          </div>}
        </section>
      </div>
    </div>
  );
}
