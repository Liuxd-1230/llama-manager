import { Check, Download, Loader2, Play, RefreshCw, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { toast, useStore } from "../store";
import { Button, Field, Input } from "../../../components/kit";
import { ComfyGraphView, type ComfyGraph } from "./ComfyGraphView";

interface ComfyStatus {
  url: string;
  reachable: boolean;
  has_workflow: boolean;
  bindings: Record<string, { node: string; input: string }>;
  fields: Record<string, string>;
  nodes: { node: string; class_type: string; title: string; inputs: { name: string; type: string; is_link: boolean; value: string | number | boolean | null }[] }[];
  binding_errors: string[];
}
type Bindings = Record<string, { node: string; input: string }>;

/** Image workspace: same level as Layout/Caption, not a modal. */
export function ComfyWorkspace() {
  const doc = useStore((s) => s.doc);
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
  const [negative, setNegative] = useState("");
  const [seed, setSeed] = useState(-1);
  const [width, setWidth] = useState(doc?.layout.width ?? 1024);
  const [height, setHeight] = useState(doc?.layout.height ?? 1536);
  const [cfg, setCfg] = useState(7);
  const [sampler, setSampler] = useState("euler");
  const [scheduler, setScheduler] = useState("normal");
  const [steps, setSteps] = useState(20);
  const [result, setResult] = useState<{ image: string; filename: string } | null>(null);
  const [focusNode, setFocusNode] = useState<string | null>(null);
  const saveTimer = useRef(0);

  const applyStatus = useCallback((s: ComfyStatus, restore: boolean) => {
    setStatus(s);
    setLabels(s.fields || {});
    setUrl(s.url);
    setBindingErrors(s.binding_errors || []);
    if (restore) setBindings(s.bindings || {});
  }, []);

  const loadStatus = useCallback(async (restore = true) => {
    try {
      const s = await api.comfyStatus();
      setStatusError("");
      applyStatus(s, restore);
      if (s.has_workflow) setGraph(await api.comfyGraph());
      else setGraph({ nodes: [], edges: [] });
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }, [applyStatus]);

  useEffect(() => { void loadStatus() }, [loadStatus]);
  useEffect(() => {
    const timer = window.setInterval(() => { void loadStatus(false) }, 5000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  const persist = useCallback(async (next: Bindings) => {
    setBusy("bind");
    try {
      await api.comfyBindings(next);
      setDirty(false);
      setBindingErrors([]);
    } catch (error) {
      toast(`绑定保存失败：${error instanceof Error ? error.message : String(error)}`, "err");
    } finally { setBusy(""); }
  }, []);

  const changeBinding = (next: Bindings) => {
    setBindings(next);
    setDirty(true);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void persist(next), 400);
  };

  const importWorkflow = async () => {
    if (!raw.trim()) { toast("先选择或粘贴 API 格式的 workflow", "err"); return }
    setBusy("import");
    try {
      const r = await api.comfyImport(raw);
      setLabels(r.fields);
      const suggested = r.suggested || {};
      setBindings(suggested);
      await api.comfyBindings(suggested);
      setDirty(false);
      toast(`已导入 ${r.nodes.length} 个节点`, "ok");
      await loadStatus(false);
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

  const generate = async () => {
    setBusy("gen");
    try {
      const r = await api.comfyGenerate({ positive, negative, seed: seed < 0 ? Math.floor(Math.random() * 2 ** 32) : seed, width, height, cfg, sampler, scheduler, steps });
      setResult(r);
      toast(`出图完成（${r.count} 张）`, "ok");
    } catch (error) {
      toast(`生成失败：${error instanceof Error ? error.message : String(error)}`, "err");
    } finally { setBusy(""); }
  };

  const connected = status?.reachable === true;
  const canGenerate = connected && Boolean(status?.has_workflow) && busy === "" && !dirty && bindingErrors.length === 0;
  const boundCount = Object.keys(bindings).length;

  return (
    <div className="image-ws">
      <header className="image-ws-head">
        <span className="comfy-state" data-state={connected ? "ok" : status ? "bad" : "unknown"}>
          <i />{connected ? `已连接 ${status?.url}` : status ? `连不上 ${status?.url}` : statusError ? `状态不可用：${statusError}` : "检测中…"}
        </span>
        <span className="image-ws-meta">{graph.nodes.length} 节点 · {boundCount} 通配</span>
        <div className="image-ws-chips">
          {Object.entries(bindings).map(([field, binding]) => {
            const node = graph.nodes.find((n) => n.id === binding.node);
            return <button key={field} type="button" className="image-ws-chip" title={`${labels[field] || field} → ${node?.title || binding.node}.${binding.input}（点击定位节点）`}
              onClick={() => setFocusNode(binding.node)}>
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
          <div className="group-title"><Upload size={13}/>连接与 workflow</div>
          <div className="row" style={{ gap: 6 }}>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:8188" aria-label="ComfyUI 地址" />
            <Button size="small" disabled={busy !== ""} onClick={() => void saveUrl()}>{busy === "url" ? "…" : "保存并测试"}</Button>
          </div>
          <textarea className="textarea mono" rows={4} placeholder="在 ComfyUI 里用「保存 (API Format)」导出，然后粘贴 JSON" value={raw} onChange={(e) => setRaw(e.target.value)} />
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
            <Button size="small" disabled={busy !== ""} onClick={() => void importWorkflow()}>{busy === "import" ? "解析中…" : "解析并绑定"}</Button>
            {dirty ? <span className="hint" data-state="pending">绑定未保存…</span> : <span className="hint" data-state="ok"><Check size={11}/>绑定已同步</span>}
          </div>

          {bindingErrors.length > 0 && <div className="comfy-error" role="alert">
            <X size={12}/>{bindingErrors[0]}{bindingErrors.length > 1 ? `（另有 ${bindingErrors.length - 1} 项）` : ""}
          </div>}

          <div className="group-title" style={{ marginTop: 10 }}><Play size={13}/>本次参数</div>
          <Field label="正向提示词"><textarea className="textarea" rows={3} value={positive} onChange={(e) => setPositive(e.target.value)} placeholder="留空则沿用 workflow 自带的提示词" /></Field>
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
            <Field label="采样器"><Input value={sampler} onChange={(e) => setSampler(e.target.value)} /></Field>
            <Field label="调度器"><Input value={scheduler} onChange={(e) => setScheduler(e.target.value)} /></Field>
          </div>
          <div className="hint">宽高默认跟随画布（{doc?.layout.width}×{doc?.layout.height}），可覆盖；留空字段沿用 workflow 原值。</div>

          {result && <div className="image-ws-result">
            <img src={result.image} alt={result.filename} />
            <div className="row">
              <a className="btn btn-sm" href={result.image} download={result.filename}><Download size={13}/>下载</a>
              <span className="hint">{result.filename}</span>
            </div>
          </div>}
        </section>

        <section className="image-ws-col image-ws-graph">
          <div className="group-title">节点图与通配符<span className="hint" style={{ marginLeft: 8, fontWeight: 400 }}>点击节点 → 右侧列出输入 → 绑定为通配符；连线输入不可绑定</span></div>
          <ComfyGraphView
            graph={graph}
            bindings={bindings}
            fieldLabels={labels}
            focusNode={focusNode}
            onBind={(field, binding) => {
              const next = { ...bindings };
              if (binding) next[field] = binding; else delete next[field];
              changeBinding(next);
            }}
            onLayout={(positions) => void api.comfyLayout(positions).catch(() => undefined)}
          />
        </section>
      </div>
    </div>
  );
}
