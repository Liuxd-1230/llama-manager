import {
  Archive, ArrowDown, ArrowUp, Bot, Check, Copy, FilePlus2, History, ImageUp, KeyRound, Loader2, Plug,
  Plus, RotateCcw, Search, Settings, Sparkles, Trash2, Upload, User, X, Zap,
} from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { ReverseModal } from "./ReverseModal";
import { confirmDialog, promptDialog } from "../dialog";
import { boxColor, clone, emptyDoc, normalizeDoc, normalizeLayout, snap16 } from "../lib/doc";
import {
  DEFAULT_QUICK, addPage, currentPage, draftLayout, flushSave, replaceCurrentDoc, setQuick, setUi, toast, useStore, type DraftOpts, type QuickAction, useWorkState } from "../store";
import type { AppSettings, ArchiveItem, Doc, Revision, Skill, SkillKind } from "../types";
import { RESOLUTIONS } from "../types";
import { AutoTextarea, Dial, Modal, Seg, cx } from "../../../components/kit";

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmtTime = (t?: string) => {
  if (!t) return "";
  const d = new Date(t);
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  return same ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

// ---------- 文档缩略图 ----------
export function DocPreview({ doc, size = 150 }: { doc: Doc; size?: number }) {
  const d = normalizeDoc(doc);
  if (d.kind === "caption")
    return <div className="doc-preview caption" style={{ width: size, height: size * 0.75 }}><p>{d.caption.caption || "（空 Caption）"}</p></div>;
  const L = d.layout;
  const k = Math.min(size / L.width, size / L.height);
  return (
    <svg className="doc-preview" width={L.width * k} height={L.height * k} viewBox={`0 0 ${L.width} ${L.height}`}>
      <rect width={L.width} height={L.height} fill="#fff" />
      {L.items.filter((x) => !x.hidden).map((it, i) => (
        <rect key={it.id} x={it.bbox[0]} y={it.bbox[1]} width={it.bbox[2] - it.bbox[0]} height={it.bbox[3] - it.bbox[1]}
          fill={boxColor(it, i)} fillOpacity={0.14} stroke={boxColor(it, i)} strokeWidth={Math.max(2, L.width / 160)} rx={L.width / 120} />
      ))}
    </svg>
  );
}

// ---------- Skills ----------
const KIND_TEXT: Record<SkillKind, string> = { layout: "Layout 起稿", caption: "Caption 起稿", context: "改稿风格" };

function SkillsModal() {
  const st = useStore((s) => s.skills);
  const [cur, setCur] = useState<string>(() => st?.active.layout || st?.skills[0]?.id || "");
  const [draft, setDraft] = useState<Skill | null>(null);
  const reload = async (focus?: string) => {
    const r = await api.skills();
    useStore.setState({ skills: r });
    if (focus) setCur(focus);
  };
  const sk = st?.skills.find((x) => x.id === cur) || null;
  useEffect(() => setDraft(sk ? clone(sk) : null), [cur, st]);
  if (!st) return null;
  const dirty = draft && sk && (draft.name !== sk.name || draft.description !== sk.description || draft.system_prompt !== sk.system_prompt);
  return (
    <Modal className="studio-root" wide title="Skills" icon={<Sparkles size={16} />} onClose={() => setUi({ modal: null })}>
      <div className="skills">
        <div className="skills-list">
          {(["layout", "caption", "context"] as SkillKind[]).map((k) => (
            <div key={k}>
              <div className="menu-label">{KIND_TEXT[k]}</div>
              {st.skills.filter((x) => x.kind === k).map((x) => (
                <button key={x.id} type="button" className={cx("skill-row", x.id === cur && "on")} onClick={() => setCur(x.id)}>
                  <span className="ellipsis grow">{x.name}</span>
                  {st.active[k] === x.id && <span className="badge accent">使用中</span>}
                  {x.builtin && <span className="badge">官方</span>}
                </button>
              ))}
            </div>
          ))}
          <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={async () => {
            const name = await promptDialog("新建 Skill 名称", "我的 Layout 风格");
            if (!name) return;
            const sk2 = await api.createSkill({ name, kind: sk?.kind || "layout", description: "", system_prompt: sk?.system_prompt || "" });
            useStore.setState({ skills: { skills: sk2.skills, active: sk2.active } });
            await reload(sk2.skill.id);
          }}><Plus size={13} />新建（基于当前）</button>
        </div>
        {draft && sk && (
          <div className="skill-edit">
            <div className="row">
              <input className="input grow" value={draft.name} disabled={sk.builtin} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <span className="chip">{KIND_TEXT[sk.kind]}</span>
            </div>
            <input className="input" value={draft.description} disabled={sk.builtin} placeholder="一句话说明" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            <textarea className="textarea mono skill-text" value={draft.system_prompt} onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })} />
            <div className="row">
              <button type="button" className="btn btn-sm" disabled={st.active[sk.kind] === sk.id} onClick={async () => { useStore.setState({ skills: await api.setActiveSkill(sk.kind, sk.id) }); }}><Check size={13} />设为使用中</button>
              <button type="button" className="btn btn-sm" onClick={async () => { const d = await api.duplicateSkill(sk.id); useStore.setState({ skills: { skills: d.skills, active: d.active } }); await reload(d.skill.id); }}><Copy size={13} />复制</button>
              {sk.builtin ? (
                <button type="button" className="btn btn-sm" onClick={async () => { await api.resetSkill(sk.id); await reload(sk.id); toast("已恢复官方版本", "ok"); }}><RotateCcw size={13} />恢复官方</button>
              ) : (
                <button type="button" className="btn btn-sm btn-danger" onClick={async () => { if (await confirmDialog(`删除「${sk.name}」？`, undefined, { danger: true, okText: "删除" })) { await api.deleteSkill(sk.id); await reload(st.active[sk.kind]); } }}><Trash2 size={13} />删除</button>
              )}
              <div className="spacer" />
              <span className="hint num">{draft.system_prompt.length} 字符</span>
              <button type="button" className="btn btn-sm btn-primary" disabled={!dirty} onClick={async () => {
                try { await api.updateSkill(sk.id, sk.builtin ? { system_prompt: draft.system_prompt } : draft); await reload(sk.id); toast("已保存", "ok"); } catch (e) { toast(err(e), "err"); }
              }}>保存</button>
            </div>
            <p className="hint">Agent 会自动带上当前页类型的「使用中」Skill 和改稿风格；输入框里 @ 可以临时引用其它 Skill。Skill 里要求的输出格式会被工具协议取代。</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------- 档案库 ----------
function ArchiveModal() {
  const s = useWorkState();
  const [list, setList] = useState<ArchiveItem[] | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("全部");
  const [selId, setSelId] = useState("");
  const load = () => api.archive().then(setList);
  useEffect(() => void load(), []);
  const cats = useMemo(() => ["全部", ...Array.from(new Set((list || []).map((x) => x.category || "未分类")))], [list]);
  const shown = (list || []).filter((x) => (cat === "全部" || (x.category || "未分类") === cat) && (!q || (x.title + x.prompt).toLowerCase().includes(q.toLowerCase())));
  const cur = shown.find((x) => x.id === selId) || shown[0];
  const page = currentPage(s);
  return (
    <Modal className="studio-root" wide title="档案库" icon={<Archive size={16} />} onClose={() => setUi({ modal: null })}
      head={<button type="button" className="btn btn-sm" onClick={async () => {
        const title = await promptDialog("存入档案库", page?.name || "未命名");
        if (!title) return;
        const category = (await promptDialog("分类（可留空）", cat !== "全部" ? cat : "")) || "";
        await flushSave();
        await api.addArchive({ title, category, doc: useStore.getState().doc!, prompt: useStore.getState().compileResult?.prompt || "" });
        await load();
        toast("已存入", "ok");
      }}><Plus size={13} />存入当前页</button>}>
      <div className="archive">
        <div className="archive-side">
          <div className="search"><Search size={13} /><input className="input" placeholder="搜索标题 / 提示词" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="cats">{cats.map((c) => <button key={c} type="button" className={cx("chip", c === cat && "accent")} onClick={() => setCat(c)}>{c}</button>)}</div>
          <div className="archive-list">
            {list === null ? <div className="empty"><Loader2 size={14} className="spin" /></div> : !shown.length ? <div className="empty">没有记录</div> : shown.map((x) => (
              <button key={x.id} type="button" className={cx("archive-row", cur?.id === x.id && "on")} onClick={() => setSelId(x.id)}>
                <span className="ellipsis grow">{x.title}</span>
                <span className="badge">{x.kind === "layout" ? "L" : "C"}</span>
                <span className="muted num" style={{ fontSize: 11 }}>{fmtTime(x.updated_at)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="archive-main">
          {cur ? (
            <>
              <div className="row">
                <b className="grow ellipsis" style={{ fontSize: 14 }}>{cur.title}</b>
                <span className="chip">{cur.category || "未分类"}</span>
              </div>
              <div className="row" style={{ alignItems: "flex-start", gap: 14 }}>
                <DocPreview doc={cur.doc} size={200} />
                <pre className="prompt-out mono grow" style={{ maxHeight: 260 }}>{cur.prompt || normalizeDoc(cur.doc).layout.summary.caption || normalizeDoc(cur.doc).caption.caption}</pre>
              </div>
              <div className="row wrap">
                <button type="button" className="btn btn-sm btn-primary" onClick={async () => {
                  if (!(await confirmDialog("用这条档案替换当前页？", "当前内容会先存进操作记录，可以回滚或撤销。"))) return;
                  await replaceCurrentDoc(normalizeDoc(cur.doc), "archive", `载入档案「${cur.title}」`);
                  setUi({ modal: null });
                }}>载入到当前页</button>
                <button type="button" className="btn btn-sm" onClick={async () => { await addPage({ doc: normalizeDoc(cur.doc), name: cur.title }); setUi({ modal: null }); }}><FilePlus2 size={13} />新建一页载入</button>
                <button type="button" className="btn btn-sm" disabled={!cur.prompt} onClick={() => { void navigator.clipboard.writeText(cur.prompt); toast("已复制提示词", "ok"); }}><Copy size={13} />复制提示词</button>
                <div className="spacer" />
                <button type="button" className="btn btn-sm btn-ghost" onClick={async () => { const t = await promptDialog("重命名", cur.title); if (t) { await api.patchArchive(cur.id, { title: t }); await load(); } }}>重命名</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={async () => { const c = await promptDialog("分类", cur.category); if (c !== null) { await api.patchArchive(cur.id, { category: c }); await load(); } }}>分类</button>
                <button type="button" className="btn btn-sm btn-ghost btn-danger" onClick={async () => { if (await confirmDialog(`删除「${cur.title}」？`, undefined, { danger: true, okText: "删除" })) { await api.deleteArchive(cur.id); await load(); } }}><Trash2 size={13} /></button>
              </div>
            </>
          ) : <div className="empty">档案库可以保存整页文档（含框、描述、机位）和编译结果，在任何系列里复用。</div>}
        </div>
      </div>
    </Modal>
  );
}

// ---------- 操作记录 ----------
const SRC: Record<string, { t: string; ic: React.ReactNode }> = {
  manual: { t: "手动编辑", ic: <User size={12} /> },
  agent: { t: "Agent 改动", ic: <Bot size={12} /> },
  restore: { t: "回滚", ic: <RotateCcw size={12} /> },
  archive: { t: "载入档案", ic: <Archive size={12} /> },
  reverse: { t: "图像反推", ic: <ImageUp size={12} /> },
};

function RevisionsModal() {
  const s = useWorkState();
  const page = currentPage(s);
  const [list, setList] = useState<Revision[] | null>(null);
  const [sel, setSel] = useState<Revision & { doc?: Doc } | null>(null);
  useEffect(() => {
    void flushSave().then(() => api.revisions(s.pageId).then(setList));
  }, [s.pageId]);
  useEffect(() => {
    if (list?.length && !sel) void api.revision(list[0].id).then(setSel);
  }, [list]);
  return (
    <Modal className="studio-root" wide title={`操作记录 · ${page?.name || ""}`} icon={<History size={16} />} onClose={() => setUi({ modal: null })}>
      <div className="archive">
        <div className="archive-side">
          <p className="hint" style={{ margin: "0 0 8px" }}>每条记录是该操作<b>之前</b>的页面状态。Agent 改动、载入、回滚都会自动留档；手动编辑每两分钟留一次。</p>
          <div className="archive-list">
            {list === null ? <div className="empty"><Loader2 size={14} className="spin" /></div> : !list.length ? <div className="empty">还没有记录</div> : list.map((r) => (
              <button key={r.id} type="button" className={cx("archive-row rev-row-item", sel?.id === r.id && "on")} onClick={() => void api.revision(r.id).then(setSel)}>
                <span className="rev-ic">{SRC[r.source]?.ic || <History size={12} />}</span>
                <span className="grow col" style={{ gap: 0, minWidth: 0 }}>
                  <span className="ellipsis">{SRC[r.source]?.t || r.source}</span>
                  {r.summary && <span className="hint ellipsis">{r.summary}</span>}
                </span>
                <span className="muted num" style={{ fontSize: 11 }}>{fmtTime(r.created_at)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="archive-main">
          {sel?.doc ? (
            <>
              <div className="row"><b>{SRC[sel.source]?.t || sel.source} 之前</b><span className="muted num">{new Date(sel.created_at).toLocaleString("zh-CN")}</span></div>
              <div className="row" style={{ alignItems: "flex-start", gap: 14 }}>
                <DocPreview doc={sel.doc} size={220} />
                <div className="reverse-text grow">{normalizeDoc(sel.doc).kind === "layout" ? normalizeDoc(sel.doc).layout.summary.caption || "（无整体描述）" : normalizeDoc(sel.doc).caption.caption}</div>
              </div>
              <div className="row">
                <button type="button" className="btn btn-sm btn-primary" onClick={async () => {
                  if (!(await confirmDialog("回滚到这个版本？", "当前状态会先保存为一条新记录。"))) return;
                  await flushSave();
                  const p = await api.restoreRevision(sel.id);
                  const doc = normalizeDoc(p.doc);
                  const st = useStore.getState();
                  useStore.setState({ doc, undo: st.doc ? [...st.undo, st.doc] : st.undo, redo: [], compileStale: true, saveState: "saved" });
                  setUi({ modal: null });
                  toast("已回滚（可撤销）", "ok");
                }}><RotateCcw size={13} />回滚到此版本</button>
              </div>
            </>
          ) : <div className="empty">选择左侧的一条记录查看</div>}
        </div>
      </div>
    </Modal>
  );
}

// ---------- 快捷操作 ----------
function QuickModal() {
  const quick = useStore((s) => s.quick);
  const [list, setList] = useState<QuickAction[]>(() => clone(quick));
  const up = (i: number, p: Partial<QuickAction>) => setList(list.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, d: number) => {
    const n = [...list];
    const j = i + d;
    if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j], n[i]];
    setList(n);
  };
  return (
    <Modal className="studio-root" title="快捷操作" icon={<Zap size={16} />} onClose={() => setUi({ modal: null })}
      foot={<>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setList(clone(DEFAULT_QUICK))}><RotateCcw size={13} />恢复默认</button>
        <div className="spacer" />
        <button type="button" className="btn" onClick={() => setUi({ modal: null })}>取消</button>
        <button type="button" className="btn btn-primary" onClick={() => { setQuick(list.filter((x) => x.label.trim() && x.prompt.trim())); setUi({ modal: null }); }}>保存</button>
      </>}>
      <div className="col" style={{ gap: 10 }}>
        {list.map((q, i) => (
          <div key={q.id} className="quick-edit">
            <div className="row">
              <input className="input" style={{ width: 160 }} value={q.label} placeholder="按钮名" onChange={(e) => up(i, { label: e.target.value })} />
              <div className="spacer" />
              <button type="button" className="btn btn-ghost btn-xs btn-icon" onClick={() => move(i, -1)}><ArrowUp size={12} /></button>
              <button type="button" className="btn btn-ghost btn-xs btn-icon" onClick={() => move(i, 1)}><ArrowDown size={12} /></button>
              <button type="button" className="btn btn-ghost btn-xs btn-icon btn-danger" onClick={() => setList(list.filter((_, j) => j !== i))}><Trash2 size={12} /></button>
            </div>
            <AutoTextarea className="textarea" minRows={2} value={q.prompt} placeholder="发给 Agent 的指令" onChange={(e) => up(i, { prompt: e.target.value })} />
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => setList([...list, { id: `q${Date.now()}`, label: "新操作", prompt: "" }])}><Plus size={13} />添加</button>
      </div>
    </Modal>
  );
}


// ---------- AI 起稿 ----------
type DraftPrefs = { canvas: string; mode: DraftOpts["mode"]; camera: boolean; lighting: boolean; autoAccept: boolean };
const DRAFT_KEY = "moss.draft.prefs";
const DRAFT_DEFAULT: DraftPrefs = { canvas: "keep", mode: "replace", camera: true, lighting: true, autoAccept: false };
let draftSeed = "";
let draftLast = "";
export function draftPrefs(): DraftPrefs {
  try {
    return { ...DRAFT_DEFAULT, ...(JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}") as Partial<DraftPrefs>) };
  } catch {
    return { ...DRAFT_DEFAULT };
  }
}
function saveDraftPrefs(p: DraftPrefs) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
export function draftCanvas(v: string): DraftOpts["canvas"] {
  if (v === "keep" || v === "ai") return v;
  const [w, h] = v.split("x").map(Number);
  return w > 0 && h > 0 ? { w, h } : "keep";
}
/** 打开 AI 起稿弹窗；seed = 预填的描述 */
export function openDraft(seed?: string) {
  draftSeed = seed ?? "";
  setUi({ modal: "draft" });
}
/** 空画布卡片 / 命令行：用上次的选项直接起稿 */
export function quickDraft(text: string, patch?: Partial<DraftPrefs>): boolean {
  const p = { ...draftPrefs(), ...patch };
  const doc = useStore.getState().doc;
  const empty = !!doc && doc.kind === "layout" && !doc.layout.items.length;
  draftLast = text;
  // 描述里点名了画幅（竖图 / 横幅 / 16:9…）时让 AI 决定，免得和“保持当前”打架
  if (p.canvas === "keep" && /竖图|竖幅|竖屏|横图|横幅|横屏|宽屏|方图|方形|\d+\s*[:：比]\s*\d+/.test(text)) p.canvas = "ai";
  return draftLayout({ text, canvas: draftCanvas(p.canvas), mode: empty ? "replace" : p.mode, camera: p.camera, lighting: p.lighting, autoAccept: p.autoAccept });
}

const DRAFT_EXAMPLES = [
  "雨夜霓虹街头，穿风衣的女侦探站在画面左侧回头看，右后方是闪烁的中文招牌「夜来香」，低机位仰拍",
  "午后老茶馆的窗边，两位老人隔着方桌下象棋，桌上有盖碗茶，暖阳从窗外斜射进来",
  "香水产品海报：画面中央一瓶琥珀色香水，背景是流动的香槟色丝绸，顶部大标题「ÉCLAT」，底部一行小字",
  "雪山脚下的营地，一名登山者背对镜头坐在帐篷前看日出，远处是连绵的雪峰，广角俯拍",
];

function DraftModal() {
  const doc = useStore((s) => s.doc);
  const streaming = useStore((s) => s.streaming);
  const isLayout = doc?.kind === "layout";
  const L = isLayout ? doc!.layout : null;
  const n = L?.items.length ?? 0;
  const [text, setText] = useState(() => {
    const seed = draftSeed || draftLast || (L && !n ? L.summary.caption || "" : "");
    draftSeed = "";
    return seed;
  });
  const [p, setP] = useState<DraftPrefs>(() => {
    const d = draftPrefs();
    if (!isLayout) d.mode = "page";
    else if (!n) d.mode = "replace";
    return d;
  });
  const up = (x: Partial<DraftPrefs>) => setP({ ...p, ...x });
  const close = () => { draftLast = text; setUi({ modal: null }); };
  const go = () => {
    if (!text.trim()) return;
    saveDraftPrefs(isLayout && n ? p : { ...p, mode: draftPrefs().mode });
    draftLast = text;
    if (draftLayout({ text, canvas: p.mode === "append" ? "keep" : draftCanvas(p.canvas), mode: p.mode, camera: p.camera, lighting: p.lighting, autoAccept: p.autoAccept })) {
      draftLast = "";
      setUi({ modal: null });
    }
  };
  const fixed = p.canvas !== "keep" && p.canvas !== "ai";
  const canvasHint = p.mode === "append" ? `追加时保持当前 ${L?.width}×${L?.height}`
    : p.canvas === "ai" ? "按内容自动选竖幅 / 横幅 / 方形" : p.canvas === "keep" ? (L ? `当前 ${L.width}×${L.height}` : "") : "";
  return (
    <Modal className="studio-root" title="AI 起稿" icon={<Sparkles size={16} />} onClose={close}
      foot={<>
        <span className="hint">{streaming ? "Agent 正在回复，生成会排在后面" : "Ctrl+Enter 生成 · 结果可整体撤销"}</span>
        <div className="spacer" />
        <button type="button" className="btn" onClick={close}>取消</button>
        <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={go}><Sparkles size={13} />生成布局</button>
      </>}>
      <div className="draft-form">
        <div className="field">
          <label>画面描述</label>
          <AutoTextarea className="textarea" minRows={4} maxRows={12} autoFocus value={text}
            placeholder="用一段话描述画面：主体是谁、在哪、在做什么、画面里有哪些东西和文字、什么光线和机位……"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); go(); } }} />
          <div className="draft-examples">
            <span className="hint">试试：</span>
            {DRAFT_EXAMPLES.map((x) => (
              <button key={x} type="button" className="chip draft-ex" title={x} onClick={() => setText(x)}>{x.slice(0, 14)}…</button>
            ))}
          </div>
        </div>
        <div className="draft-grid">
          <div className="field">
            <label>写到哪里</label>
            <Seg<DraftOpts["mode"]> value={p.mode} onChange={(v) => up({ mode: isLayout ? v : "page" })} full options={([
              { v: "replace", t: "替换当前页", title: isLayout ? "用新布局替换当前页（可撤销）" : "Caption 页不能替换" },
              { v: "append", t: "追加到当前页", title: "保留已有的框，只加新框" },
              { v: "page", t: "新建一页", title: "在当前系列新建一页再起稿" },
            ] as { v: DraftOpts["mode"]; t: string; title: string }[]).map((o) => ({ ...o, t: <span className={cx(!isLayout && o.v !== "page" && "muted")}>{o.t}</span> }))} />
            <span className="hint">
              {!isLayout ? "当前是 Caption 页，会新建一页 Layout"
                : p.mode === "replace" ? (n ? `会替换掉当前的 ${n} 个框（Ctrl+Z 可恢复）` : "当前页是空的，直接画上去")
                  : p.mode === "append" ? `保留当前 ${n} 个框，按描述补上新的` : "新页会在当前页后面"}
            </span>
          </div>
          <div className="field">
            <label>画幅</label>
            <Seg value={fixed ? "fixed" : p.canvas} disabled={p.mode === "append"} onChange={(v) => up({ canvas: v === "fixed" ? `${RESOLUTIONS[0].width}x${RESOLUTIONS[0].height}` : v })} full options={[
              { v: "keep", t: "保持当前" }, { v: "ai", t: "AI 决定" }, { v: "fixed", t: "指定" },
            ]} />
            {fixed && p.mode !== "append" ? (
              <div className="draft-res">
                {RESOLUTIONS.map((r) => {
                  const v = `${r.width}x${r.height}`;
                  return <button key={v} type="button" className={cx("chip", p.canvas === v && "accent")} onClick={() => up({ canvas: v })}>{r.name}<span className="num muted"> {r.width}×{r.height}</span></button>;
                })}
              </div>
            ) : <span className="hint">{canvasHint}</span>}
          </div>
        </div>
        <div className="draft-opts">
          <label className="assist-opt"><input type="checkbox" checked={p.camera} onChange={(e) => up({ camera: e.target.checked })} /><span>同时设置机位（按描述里的俯拍 / 仰拍 / 景别打开摄像机）</span></label>
          <label className="assist-opt"><input type="checkbox" checked={p.lighting} onChange={(e) => up({ lighting: e.target.checked })} /><span>同时设置灯光（选合适的打光预设，灯光描述写进提示词）</span></label>
          <label className="assist-opt"><input type="checkbox" checked={p.autoAccept} onChange={(e) => up({ autoAccept: e.target.checked })} /><span>直接画到画布并编译（关掉则在 Agent 面板里逐条采纳）</span></label>
        </div>
      </div>
    </Modal>
  );
}

export function Modals() {
  const m = useStore((s) => s.modal);
  if (m === "skills") return <SkillsModal />;
  if (m === "reverse") return <ReverseModal />;
  if (m === "archive") return <ArchiveModal />;
  if (m === "revisions") return <RevisionsModal />;
  if (m === "quick") return <QuickModal />;
  if (m === "draft") return <DraftModal />;
  return null;
}
