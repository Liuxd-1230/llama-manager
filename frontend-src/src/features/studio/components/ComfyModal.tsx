import { Download, ImagePlus, Link2, Loader2, Play, RefreshCw, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { toast, useStore } from "../store";
import { Button, Field, Input, Modal, Select } from "../../../components/kit";

interface ComfyNode { node: string; class_type: string; title: string; inputs: { name: string; type: string }[] }
interface Binding { node: string; input: string }
type Bindings = Record<string, Binding>;

const FIELD_ORDER = ["positive", "negative", "seed", "width", "height", "cfg", "sampler", "scheduler", "steps"] as const;
type FieldKey = typeof FIELD_ORDER[number];

export function ComfyModal() {
  const doc = useStore((s) => s.doc);
  const close = () => useStore.setState({ modal: null });
  const [nodes, setNodes] = useState<ComfyNode[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [bindings, setBindings] = useState<Bindings>({});
  const [status, setStatus] = useState<{ url: string; reachable: boolean; has_workflow: boolean } | null>(null);
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

  const loadStatus = async (applyBindings = true) => {
    const s = await api.comfyStatus();
    setStatus(s); setLabels(s.fields || {});
    // Opening the modal restores saved bindings; after an import we keep the
    // freshly suggested ones instead (the server still holds the old set).
    if (applyBindings) setBindings(s.bindings || {});
  };
  useEffect(() => {
    void loadStatus();
    // Canvas size drives width/height by default (the user can still override).
    if (doc) { setWidth(doc.layout.width); setHeight(doc.layout.height); }
  }, []);

  const importWorkflow = async () => {
    if (!raw.trim()) return toast("先粘贴 API 格式的 workflow JSON", "err");
    setBusy("import");
    try {
      const r = await api.comfyImport(raw);
      setNodes(r.nodes); setLabels(r.fields);
      // The backend derives bindings from the workflow's own wiring.
      const suggested = r.suggested || {};
      setBindings(suggested);
      // Persist immediately: generation reads bindings from the server, so an
      // unsaved suggestion would silently run the workflow's own defaults.
      await api.comfyBindings(suggested);
      toast(`已导入 ${r.nodes.length} 个节点`, "ok");
      await loadStatus(false);
    } finally { setBusy(""); }
  };

  const saveBindings = async () => {
    setBusy("bind");
    try {
      await api.comfyBindings(bindings);
      toast("绑定已保存", "ok");
    } finally { setBusy(""); }
  };

  const generate = async () => {
    setBusy("gen");
    try {
      const r = await api.comfyGenerate({ positive, negative, seed: seed < 0 ? Math.floor(Math.random() * 2 ** 32) : seed, width, height, cfg, sampler, scheduler, steps });
      setResult(r);
      toast(`出图完成（${r.count} 张）`, "ok");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "err");
    } finally { setBusy(""); }
  };

  const nodeOptions = useMemo(() => nodes.map((n) => ({ value: n.node, label: `${n.title} · ${n.class_type} (#${n.node})` })), [nodes]);

  return (
    <Modal className="studio-root" wide title="ComfyUI 出图" icon={<ImagePlus size={16} />} onClose={close}
      foot={<>
        <span className="hint">{status ? (status.reachable ? `已连接 ${status.url}` : `连不上 ${status.url}`) : "检查连接…"}</span>
        <div className="spacer" />
        <Button onClick={() => void loadStatus()}><RefreshCw size={13}/>刷新</Button>
        <Button tone="primary" disabled={busy !== "" || !status?.has_workflow} onClick={() => void generate()}>{busy === "gen" ? <Loader2 size={13} className="spin"/> : <Play size={13}/>}生成</Button>
      </>}>
      <div className="comfy">
        <section className="comfy-col">
          <div className="group-title"><Upload size={13}/>1. 导入 workflow（API 格式）</div>
          <textarea className="textarea mono" rows={6} placeholder='在 ComfyUI 里用「保存 (API Format)」导出，然后粘贴 JSON' value={raw} onChange={(e) => setRaw(e.target.value)} />
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
          </div>

          <div className="group-title" style={{ marginTop: 14 }}><Link2 size={13}/>2. 字段绑定</div>
          {FIELD_ORDER.map((field) => {
            const bound = bindings[field];
            const node = nodes.find((n) => n.node === bound?.node);
            return <Field key={field} label={labels[field] || field}>
              <div className="row" style={{ gap: 6 }}>
                <Select value={bound?.node || ""} onChange={(e) => {
                  const next = { ...bindings };
                  const picked = nodes.find((n) => n.node === e.target.value);
                  if (picked) next[field] = { node: picked.node, input: picked.inputs[0]?.name || "" };
                  else delete next[field];
                  setBindings(next);
                }}>
                  <option value="">不绑定</option>
                  {nodeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
                <Select value={bound?.input || ""} disabled={!node} onChange={(e) => setBindings({ ...bindings, [field]: { node: bound!.node, input: e.target.value } })}>
                  {(node?.inputs || []).map((input) => <option key={input.name} value={input.name}>{input.name} ({input.type})</option>)}
                </Select>
              </div>
            </Field>;
          })}
          <Button size="small" disabled={busy !== ""} onClick={() => void saveBindings()}>保存绑定</Button>
        </section>

        <section className="comfy-col">
          <div className="group-title"><Play size={13}/>3. 本次参数</div>
          <Field label="正向提示词"><textarea className="textarea" rows={4} value={positive} onChange={(e) => setPositive(e.target.value)} /></Field>
          <Field label="负向提示词"><textarea className="textarea" rows={2} value={negative} onChange={(e) => setNegative(e.target.value)} /></Field>
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
          <div className="hint">宽度/高度默认跟随画布（{doc?.layout.width}×{doc?.layout.height}），可在此覆盖。</div>

          {result && <div style={{ marginTop: 12 }}>
            <img src={result.image} alt={result.filename} style={{ width: "100%", borderRadius: 4, border: "1px solid var(--line)" }} />
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
