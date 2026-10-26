import { Check, Download, ImagePlus, Link2, Loader2, Play, RefreshCw, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { toast, useStore } from "../store";
import { Button, Field, Input, Modal, Select } from "../../../components/kit";

interface ComfyInput { name: string; type: string; is_link: boolean; value: string | number | boolean | null }
interface ComfyNode { node: string; class_type: string; title: string; inputs: ComfyInput[] }
interface Binding { node: string; input: string }
type Bindings = Record<string, Binding>;

interface ComfyStatus {
  url: string;
  reachable: boolean;
  has_workflow: boolean;
  bindings: Bindings;
  fields: Record<string, string>;
  nodes: ComfyNode[];
  binding_errors: string[];
}

const FIELD_ORDER = ["positive", "negative", "seed", "width", "height", "cfg", "sampler", "scheduler", "steps"] as const;

export function ComfyModal() {
  const doc = useStore((s) => s.doc);
  const close = () => useStore.setState({ modal: null });
  const [nodes, setNodes] = useState<ComfyNode[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [bindings, setBindings] = useState<Bindings>({});
  const [status, setStatus] = useState<ComfyStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [bindingErrors, setBindingErrors] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [raw, setRaw] = useState("");
  const [positive, setPositive] = useState("");
  const [negative, setNegative] = useState("");
  const [seed, setSeed] = useState(-1);
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1536);
  const [cfg, setCfg] = useState(7);
  const [sampler, setSampler] = useState("euler");
  const [scheduler, setScheduler] = useState("normal");
  const [steps, setSteps] = useState(20);
  const [result, setResult] = useState<{ image: string; filename: string } | null>(null);
  const saveTimer = useRef(0);

  const applyStatus = useCallback((s: ComfyStatus, restoreBindings: boolean) => {
    setStatus(s);
    setLabels(s.fields || {});
    setNodes(s.nodes || []);
    setUrl(s.url);
    setBindingErrors(s.binding_errors || []);
    // Never clobber unsaved dropdown edits with the server copy.
    if (restoreBindings) setBindings(s.bindings || {});
  }, []);

  const loadStatus = useCallback(async (restoreBindings = true) => {
    try {
      const s = await api.comfyStatus();
      setStatusError("");
      applyStatus(s, restoreBindings);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }, [applyStatus]);

  useEffect(() => {
    void loadStatus();
    if (doc) { setWidth(doc.layout.width); setHeight(doc.layout.height); }
  }, [loadStatus, doc]);

  // Poll so a ComfyUI started (or stopped) after opening the dialog shows up.
  useEffect(() => {
    const timer = window.setInterval(() => { void loadStatus(false) }, 5000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  // Bindings save themselves: generation reads them from the server, so an
  // unsaved dropdown edit would silently run the previous set.
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

  const changeBinding = (field: string, next: Bindings) => {
    setBindings(next);
    setDirty(true);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void persist(next), 400);
  };

  const importWorkflow = async () => {
    if (!raw.trim()) { toast("先粘贴 API 格式的 workflow JSON", "err"); return }
    setBusy("import");
    try {
      const r = await api.comfyImport(raw);
      setNodes(r.nodes); setLabels(r.fields);
      const suggested = r.suggested || {};
      setBindings(suggested);
      await api.comfyBindings(suggested);
      setDirty(false);
      toast(`已导入 ${r.nodes.length} 个节点`, "ok");
      await loadStatus(false);
    } catch (error) {
      // The backend explains wrong formats precisely; never swallow that.
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

  const nodeOptions = useMemo(() => nodes.map((n) => ({ value: n.node, label: `${n.title} · ${n.class_type} (#${n.node})` })), [nodes]);
  const connected = status?.reachable === true;
  const canGenerate = connected && Boolean(status?.has_workflow) && busy === "" && !dirty && bindingErrors.length === 0;

  return (
    <Modal className="studio-root" wide title="ComfyUI 出图" icon={<ImagePlus size={16} />} onClose={close}
      foot={<>
        <span className="comfy-state" data-state={connected ? "ok" : status ? "bad" : "unknown"}>
          <i />{connected ? `已连接 ${status?.url}` : status ? `连不上 ${status?.url}` : statusError ? `状态不可用：${statusError}` : "检测中…"}
        </span>
        <div className="spacer" />
        <Button onClick={() => void loadStatus(false)}><RefreshCw size={13}/>刷新</Button>
        <Button tone="primary" disabled={!canGenerate} title={!connected ? "ComfyUI 未连接" : !status?.has_workflow ? "还没有导入 workflow" : dirty ? "绑定正在保存…" : bindingErrors.length ? "绑定已失效，请重新选择" : undefined}
          onClick={() => void generate()}>{busy === "gen" ? <Loader2 size={13} className="spin"/> : <Play size={13}/>}生成</Button>
      </>}>
      <div className="comfy">
        <section className="comfy-col">
          <div className="group-title"><Upload size={13}/>1. 连接与 workflow</div>
          <div className="row" style={{ gap: 6 }}>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:8188" aria-label="ComfyUI 地址" />
            <Button size="small" disabled={busy !== ""} onClick={() => void saveUrl()}>{busy === "url" ? "…" : "保存并测试"}</Button>
          </div>
          <textarea className="textarea mono" rows={5} placeholder='在 ComfyUI 里用「保存 (API Format)」导出，然后粘贴 JSON' value={raw} onChange={(e) => setRaw(e.target.value)} />
          <label className="btn btn-sm" style={{ alignSelf: 'flex-start' }}>
            <Upload size={13}/>选择 JSON 文件
            <input type="file" accept=".json,application/json" hidden onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setRaw(await file.text());
              toast(`已读取 ${file.name}`, "ok");
            }} />
          </label>
          <div className="row" style={{ marginTop: 6 }}>
            <Button size="small" disabled={busy !== ""} onClick={() => void importWorkflow()}>{busy === "import" ? "解析中…" : "解析并绑定"}</Button>
            {nodes.length > 0 && <span className="hint">{nodes.length} 个节点</span>}
            {dirty ? <span className="hint" data-state="pending">绑定未保存…</span> : <span className="hint" data-state="ok"><Check size={11}/>绑定已同步</span>}
          </div>

          {bindingErrors.length > 0 && <div className="comfy-error" role="alert">
            <X size={12}/>{bindingErrors[0]}{bindingErrors.length > 1 ? `（另有 ${bindingErrors.length - 1} 项）` : ""}
          </div>}

          <div className="group-title" style={{ marginTop: 12 }}><Link2 size={13}/>2. 字段绑定</div>
          {FIELD_ORDER.map((field) => {
            const bound = bindings[field];
            const node = nodes.find((n) => n.node === bound?.node);
            const bindable = (node?.inputs || []).filter((input) => !input.is_link);
            return <Field key={field} label={labels[field] || field}>
              <div className="row" style={{ gap: 6 }}>
                <Select value={bound?.node || ""} onChange={(e) => {
                  const next = { ...bindings };
                  const picked = nodes.find((n) => n.node === e.target.value);
                  if (picked) {
                    const first = picked.inputs.find((input) => !input.is_link);
                    next[field] = { node: picked.node, input: first?.name || "" };
                  } else delete next[field];
                  changeBinding(field, next);
                }}>
                  <option value="">不绑定</option>
                  {nodeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
                <Select value={bound?.input || ""} disabled={!node} onChange={(e) => changeBinding(field, { ...bindings, [field]: { node: bound!.node, input: e.target.value } })}>
                  {bindable.map((input) => <option key={input.name} value={input.name}>{input.name} ({input.type})</option>)}
                </Select>
              </div>
              {node && bound?.input && (() => {
                const current = node.inputs.find((i) => i.name === bound.input)?.value
                const text = current == null ? '—' : String(current).replace(/\s+/g, ' ')
                // Prompt nodes hold whole captions; show a preview, not the blob.
                return <span className="hint comfy-current" title={text.length > 120 ? text : undefined}>
                  当前值：{text.length > 120 ? `${text.slice(0, 120)}…（${text.length} 字符）` : text}
                </span>
              })()}
            </Field>;
          })}
        </section>

        <section className="comfy-col">
          <div className="group-title"><Play size={13}/>3. 本次参数</div>
          <Field label="正向提示词"><textarea className="textarea" rows={4} value={positive} onChange={(e) => setPositive(e.target.value)} placeholder="留空则沿用 workflow 自带的提示词" /></Field>
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
          <div className="hint">宽度/高度默认跟随画布（{doc?.layout.width}×{doc?.layout.height}），可在此覆盖。留空的字段沿用 workflow 原值。</div>

          {result && <div style={{ marginTop: 12 }}>
            <img src={result.image} alt={result.filename} style={{ width: "100%", maxHeight: "52vh", objectFit: "contain", borderRadius: 4, border: "1px solid var(--line)" }} />
            <div className="row" style={{ marginTop: 6 }}>
              <a className="btn btn-sm" href={result.image} download={result.filename}><Download size={13}/>下载</a>
              <span className="hint">{result.filename}</span>
            </div>
          </div>}
        </section>
      </div>
    </Modal>
  );
}
