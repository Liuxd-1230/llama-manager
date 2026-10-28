import { ConversationComposer, ConversationDisclosure, ConversationTool } from "../../../components/ConversationSurface";
import { AtelierGlyph } from '../../../components/AtelierBrand';
import {
  AlertTriangle, ArrowUp, AtSign, Bot, Check, CheckCheck, ChevronDown, ChevronRight, Copy, History, ImagePlus, Loader2,
  MessageSquarePlus, MousePointerClick, Pencil, RotateCcw, Settings2, Sparkles, Square, Trash2, Wrench, X, Zap, Info,
  CircleHelp, ListPlus, Eraser, Wand2, BrainCircuit,
} from "lucide-react";
import { useImeGuard, isComposingKey } from "../../../hooks/useImeGuard";
import { usePinnedScroll } from "../../../hooks/usePinnedScroll";
import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { api, attachmentUrl } from "../api";
import { confirmDialog, promptDialog } from "../dialog";
import { diffDocs, wordDiff, type Change } from "../lib/changeset";
import { openDraft, quickDraft } from "./Modals";
import { itemName, normalizeDoc } from "../lib/doc";
import {
  assistAgent, clearSession, closeSession, currentPage, currentSeries, deleteSession, dropQueued, openSession, renameSession, rerun,
  resolveProposal, selectPage, send, setAutoApprove, setUi, startNewSession, stop, toast, useStore,
} from "../store";
import { openGlobalSettings } from "../globalSettings";
import type { Ask, Attachment, Message, Proposal, Skill, Step } from "../types";
import { AutoTextarea, MenuItem, Popover, Switch, cx, useAnchor } from "../../../components/kit";
import { Markdown } from "./Markdown";

const EMPTY_MSGS: Message[] = [];
const EMPTY_SKILLS: Skill[] = [];

const SLASH = [
  { cmd: "draft", label: "AI 起稿（/draft 后接画面描述）", icon: <Sparkles size={13} /> },
  { cmd: "fill", label: "补全当前页的提示词", icon: <Wand2 size={13} /> },
  { cmd: "new", label: "开新对话", icon: <MessageSquarePlus size={13} /> },
  { cmd: "clear", label: "清空当前对话", icon: <Eraser size={13} /> },
];

/** 清空当前对话（有未处理改动时提醒一下） */
async function askClear() {
  const st = useStore.getState();
  const list = st.messages[st.sessionId] || EMPTY_MSGS;
  if (!list.length) return toast("当前对话已经是空的", "info");
  const pending = list.some((m) => (m.meta?.proposals || []).some((p) => p.status === "pending"));
  const ok = await confirmDialog("清空当前对话？",
    `删除这段对话的 ${list.length} 条消息和记忆摘要，Agent 从头开始。页面内容不受影响${pending ? "；还没处理的改动卡片会一起移除" : ""}。想保留旧对话可以改用「新对话」。`,
    { okText: "清空", danger: true });
  if (ok) await clearSession(st.sessionId).catch((e) => toast("清空失败：" + (e instanceof Error ? e.message : e), "err"));
}

// ---------------- 会话标签 ----------------
function SessionTabs() {
  const s = useStoreWithEqualityFn(useStore, (st) => ({ sessions: st.sessions, sessionId: st.sessionId, streaming: st.streaming ? { sessionId: st.streaming.sessionId } : null }),
    (a, b) => a.sessions === b.sessions && a.sessionId === b.sessionId && a.streaming?.sessionId === b.streaming?.sessionId);
  const hist = useAnchor();
  const hasMsgs = useStore((st) => (st.messages[st.sessionId] || EMPTY_MSGS).length > 0);
  const open = s.sessions.filter((x) => !x.closed);
  return (
    <div className="session-bar">
      <div className="session-tabs">
        {open.map((x) => (
          <div key={x.id} className={cx("session-tab", x.id === s.sessionId && "on")} onClick={() => void openSession(x.id)}
            onDoubleClick={async () => { const t = await promptDialog("重命名对话", x.title); if (t) void renameSession(x.id, t); }} title={`${x.title}（双击重命名）`}>
            {s.streaming?.sessionId === x.id ? <Loader2 size={11} className="spin" /> : <Bot size={11} />}
            <span className="ellipsis">{x.title}</span>
            {open.length > 1 && (
              <button type="button" className="tab-x" title="关闭（可在历史里找回）" onClick={(e) => { e.stopPropagation(); void closeSession(x.id); }}>
                <X size={11} />
              </button>
            )}
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-ghost btn-sm new-chat" title="开一个新对话，旧对话保留在标签和历史里（/new）" onClick={() => void startNewSession()}>
        <MessageSquarePlus size={14} /><span>新对话</span>
      </button>
      <button type="button" className="btn btn-ghost btn-sm btn-icon" title="清空当前对话（/clear）" disabled={!hasMsgs}
        onClick={() => void askClear()}><Eraser size={14} /></button>
      <button ref={hist.ref} type="button" className="btn btn-ghost btn-sm btn-icon" title="Agent 对话" onClick={hist.toggle}><History size={15} /></button>
      <button type="button" className="btn btn-ghost btn-sm btn-icon" title="收起 Agent" aria-label="收起 Agent" onClick={()=>{setUi({agentOpen:false,mobilePanel:'editor'});document.querySelector<HTMLButtonElement>('[data-agent-toggle]')?.focus()}}><X size={15}/></button>
      <Popover anchor={hist.ref.current} open={hist.open} onClose={hist.close} align="right" width={280}>
        <div className="menu-label">本系列的 Agent 对话</div>
        {[...s.sessions].reverse().map((x) => (
          <div key={x.id} className="hist-row">
            <MenuItem active={x.id === s.sessionId} meta={x.closed ? "已关闭" : ""} onClick={() => { hist.close(); void openSession(x.id); }}>{x.title}</MenuItem>
            <button type="button" className="btn btn-ghost btn-xs btn-icon" title="删除对话"
              onClick={async () => { if (await confirmDialog(`删除对话「${x.title}」？`, "对话记录会被删除，页面内容不受影响。", { okText: "删除", danger: true })) void deleteSession(x.id); }}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </Popover>
    </div>
  );
}

// ---------------- 改动卡片 ----------------
function ChangeRow({ ch, checked, onToggle, pending }: { ch: Change; checked: boolean; onToggle: () => void; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const hasDetail = ch.before !== undefined || ch.after !== undefined;
  const diff = useMemo(() => (open && hasDetail ? wordDiff(ch.before || "", ch.after || "") : []), [open, ch, hasDetail]);
  return (
    <div className={cx("change", `k-${ch.kind}`)}>
      <div className="change-row">
        {pending && <input type="checkbox" checked={checked} onChange={onToggle} />}
        <span className={cx("change-kind", ch.kind)}>{{ segment: "分段", add: "新增", remove: "删除", update: "修改", order: "图层", summary: "描述", caption: "文本", canvas: "画布", camera: "机位", lighting: "灯光", kind: "类型" }[ch.kind]}</span>
        <span className="change-title ellipsis" title={ch.title}>{ch.title.replace(/^(新增|修改|删除)\s*/, "")}</span>
        {hasDetail && (
          <button type="button" className="btn btn-ghost btn-xs btn-icon" onClick={() => setOpen(!open)} title="查看文字差异">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        )}
      </div>
      {open && (
        <div className="change-diff">
          {ch.kind === "add" ? <span className="d-add">{ch.after}</span> : diff.map((d, i) => <span key={i} className={`d-${d.op}`}>{d.t}</span>)}
        </div>
      )}
    </div>
  );
}

function ProposalCard({ messageId, p }: { messageId: string; p: Proposal }) {
  const pageId = useStore((s) => s.pageId);
  const changes = useMemo(() => diffDocs(normalizeDoc(p.base), normalizeDoc(p.proposed)), [p]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(changes.map((c) => c.key)));
  const [busy, setBusy] = useState(false);
  const pending = p.status === "pending";
  const go = async (status: "accepted" | "rejected" | "partial") => {
    setBusy(true);
    try {
      await resolveProposal(messageId, p.page_id, status, status === "partial" ? picked : undefined);
    } finally {
      setBusy(false);
    }
  };
  const all = picked.size === changes.length;
  return (
    <div className={cx("proposal", p.status)}>
      <div className="proposal-head">
        <ListPlus size={14} />
        <span className="proposal-title">改动 · {p.page_name}</span>
        {p.page_id !== pageId && (
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => void selectPage(p.page_id)} title="切换到这一页">查看</button>
        )}
        <div className="spacer" />
        <span className={cx("status-pill", p.status)}>{{ pending: "待采纳", accepted: "已写入", rejected: "已驳回", partial: "部分写入" }[p.status]}</span>
      </div>
      <div className="proposal-list">
        {changes.length ? changes.map((c) => (
          <ChangeRow key={c.key} ch={c} pending={pending} checked={picked.has(c.key)}
            onToggle={() => setPicked((x) => { const n = new Set(x); n.has(c.key) ? n.delete(c.key) : n.add(c.key); return n; })} />
        )) : <div className="hint">没有实际差异</div>}
      </div>
      {pending && changes.length > 0 && (
        <div className="proposal-foot">
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void go(all ? "accepted" : "partial")}>
            <Check size={13} />{all ? "采纳全部" : `采纳所选 ${picked.size}`}
          </button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void go("rejected")}><X size={13} />拒绝</button>
          <div className="spacer" />
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => setPicked(all ? new Set() : new Set(changes.map((c) => c.key)))}>{all ? "全不选" : "全选"}</button>
        </div>
      )}
    </div>
  );
}

// ---------------- 提问卡片 ----------------
function AskCard({ ask, active }: { ask: Ask; active: boolean }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const answer = (t: string) => send(t, {});
  return (
    <div className={cx("ask", !active && "done")}>
      <div className="ask-q"><CircleHelp size={14} />{ask.question}</div>
      <div className="ask-opts">
        {ask.options.map((o, i) => (
          <button key={i} type="button" disabled={!active} className={cx("ask-opt", picked.includes(o) && "on")}
            onClick={() => (ask.multi ? setPicked((x) => (x.includes(o) ? x.filter((y) => y !== o) : [...x, o])) : answer(o))}>
            <span className="ask-idx num">{i + 1}</span>
            <span>{o}</span>
          </button>
        ))}
        {active && (
          <div className="ask-other">
            <input className="input input-sm" placeholder="其他想法…" value={other} onChange={(e) => setOther(e.target.value)}
              onKeyDown={(e) => { if (!isComposingKey(e.nativeEvent) && e.key === "Enter" && other.trim()) answer(other.trim()); }} />
            {ask.multi && (
              <button type="button" className="btn btn-sm btn-primary" disabled={!picked.length && !other.trim()}
                onClick={() => answer([...picked, other.trim()].filter(Boolean).join("；"))}>发送</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- 消息 ----------------
function StepChips({ steps, pending }: { steps: Step[]; pending?: { label: string } | null }) {
  if (!steps.length && !pending) return null;
  return (
    <div className="steps">
      {steps.map((st, i) => (
        <ConversationTool key={i} label={st.label || st.name} brief={st.brief} result={st.result || ''} failed={!st.ok} />
      ))}
      {pending && <span className="step running"><Loader2 size={10} className="spin" /><b>{pending.label}</b></span>}
    </div>
  );
}

const UserMsg = memo(function UserMsg({ m, canEdit }: { m: Message; canEdit: boolean }) {
  const [edit, setEdit] = useState<string | null>(null);
  const skills = useStore((s) => s.skills?.skills || EMPTY_SKILLS);
  // 只取引用框的名字：拖动机位等改动不会让整列消息重渲染
  const sel = useStoreWithEqualityFn(useStore, (s) => (m.meta.selection || []).map((id) => {
    const it = s.doc?.layout.items.find((x) => x.id === id);
    return it ? { id: it.id, name: itemName(it) } : null;
  }).filter(Boolean) as { id: string; name: string }[], (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id && x.name === b[i].name));
  return (
    <div className="msg user">
      {edit === null ? (
        <div className="bubble">
          {m.meta.quick && <span className="chip warm quick-chip"><Zap size={10} />{m.meta.quick}</span>}
          <div className="bubble-text">{m.meta.quick ? null : m.content}</div>
          {(sel.length > 0 || (m.meta.skill_ids || []).length > 0 || (m.meta.attachments || []).length > 0) && (
            <div className="bubble-refs">
              {sel.map((it) => <span key={it.id} className="chip accent"><MousePointerClick size={10} />{it.name}</span>)}
              {(m.meta.skill_ids || []).map((id) => <span key={id} className="chip"><AtSign size={10} />{skills.find((x) => x.id === id)?.name || id}</span>)}
              {(m.meta.attachments || []).map((id) => <img key={id} className="thumb" src={attachmentUrl(id)} alt="" />)}
            </div>
          )}
        </div>
      ) : (
        <div className="bubble editing">
          <AutoTextarea className="textarea" minRows={2} value={edit} autoFocus onChange={(e) => setEdit(e.target.value)} />
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
            <button type="button" className="btn btn-xs" onClick={() => setEdit(null)}>取消</button>
            <button type="button" className="btn btn-xs btn-primary" disabled={!edit.trim()} onClick={() => { rerun(m, edit); setEdit(null); }}>重新发送</button>
          </div>
        </div>
      )}
      {canEdit && edit === null && (
        <div className="msg-actions">
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEdit(m.content)} title="编辑后重新发送（会替换之后的对话）"><Pencil size={11} />编辑</button>
        </div>
      )}
    </div>
  );
});

const AssistantMsg = memo(function AssistantMsg({ m, isLast, latestAsk }: { m: Message; isLast: boolean; latestAsk: boolean }) {
  const meta = m.meta;
  const busy = useStore((s) => !!s.streaming);
  const msgs = useStore((s) => s.messages[m.session_id] || EMPTY_MSGS);
  const prevUser = [...msgs].reverse().find((x) => x.role === "user" && x.seq < m.seq);
  return (
    <div className="msg ai">
      <StepChips steps={meta.steps || []} />
      {m.content && <Markdown text={m.content} />}
      {meta.stopped && <div className="notice"><Square size={11} />已停止</div>}
      {meta.error && <div className="notice err"><AlertTriangle size={12} />{meta.error}</div>}
      {meta.reasoning && <ReasoningBlock text={meta.reasoning} />}
      {(meta.proposals || []).map((p) => <ProposalCard key={p.page_id} messageId={m.id} p={p} />)}
      {meta.ask && <AskCard ask={meta.ask} active={latestAsk && !busy} />}
      <div className="msg-actions">
        {meta.model && <span className="muted model-tag">{meta.model}</span>}
        <button type="button" className="btn btn-ghost btn-xs btn-icon" title="复制回复" onClick={() => { void navigator.clipboard.writeText(m.content); toast("已复制", "ok"); }}><Copy size={11} /></button>
        {isLast && prevUser && !busy && (
          <button type="button" className="btn btn-ghost btn-xs" title="重新生成这一轮" onClick={() => rerun(prevUser)}><RotateCcw size={11} />重跑</button>
        )}
      </div>
    </div>
  );
});

function ReasoningBlock({ text, live }: { text: string; live?: boolean }) {
  if (!text.trim()) return null;
  return <ConversationDisclosure label="思考过程" detail={live ? '进行中' : `${text.length} 字`} busy={live}>{text}</ConversationDisclosure>;
}

function StreamingMsg() {
  const st = useStore((s) => s.streaming);
  if (!st) return null;
  return (
    <div className="msg ai streaming">
      {st.notices.map((n, i) => <div key={i} className="notice"><Info size={12} />{n}</div>)}
      <StepChips steps={st.steps} pending={st.pending} />
      <ReasoningBlock text={st.reasoning} live />
      {st.text ? <Markdown text={st.text} caret /> : !st.pending && !st.reasoning && <div className="thinking"><span /><span /><span /></div>}
      {st.error && <div className="notice err"><AlertTriangle size={12} />{st.error}</div>}
      {st.ask && <AskCard ask={st.ask} active={false} />}
      {st.model && <div className="msg-actions show"><span className="muted model-tag">{st.model}</span></div>}
    </div>
  );
}

function Welcome() {
  const kind = useStore((st) => st.doc?.kind);
  const keySet = useStore((st) => !!st.settings?.api_key_set);
  const localService = useStore((st) => st.settings?.provider_id === "local");
  const hasContent = useStore((st) => !!st.doc && (st.doc.kind === "caption" ? !!st.doc.caption.caption.trim()
    : st.doc.layout.items.length > 0 || !!st.doc.layout.summary.caption.trim()));
  const tips = kind === "caption"
    ? ["写一段雨夜霓虹街头的电影感 Caption", "把同系列第 1 页的布局写成 Caption"]
    : ["起稿：黄昏天台上的少女和一只黑猫，竖图", "主体放大一点，往左移，给标题留出顶部空间", "这页太挤了，有什么调整建议？先别改"];
  return (
    <div className="welcome">
      <div className="welcome-mark"><AtelierGlyph /></div>
      <div className="welcome-title">和 Agent 一起改稿</div>
      {hasContent && (
        <button type="button" className="tip tip-main" onClick={() => assistAgent()} title="把当前整体描述、框和机位交给 Agent 补全（不改构图）">
          <Wand2 size={13} />{kind === "caption" ? "补全当前 Caption" : "补全当前页的提示词"}
        </button>
      )}
      <div className="welcome-tips">
        {tips.map((t) => <button key={t} type="button" className="tip" onClick={() => (t.startsWith("起稿：") ? quickDraft(t.slice(3)) : send(t))}>{t}</button>)}
      </div>
      {!keySet && !localService && (
        <div className="notice warn"><AlertTriangle size={12} />未配置 API Key；编辑与编译仍可用。<button type="button" className="link" onClick={openGlobalSettings}>去设置</button></div>
      )}
    </div>
  );
}

function MessageList() {
  const s = {
    sessionId: useStore((st) => st.sessionId),
    streaming: useStore((st) => st.streaming),
    sessions: useStore((st) => st.sessions),
  };
  const list = useStore((st) => st.messages[st.sessionId] || EMPTY_MSGS);
  const feed = usePinnedScroll(s.streaming || list, s.sessionId);
  const lastAi = [...list].reverse().find((m) => m.role === "assistant");
  const lastUser = [...list].reverse().find((m) => m.role === "user");
  const sess = s.sessions.find((x) => x.id === s.sessionId);
  return (
    <div className="messages-shell"><div ref={feed.containerRef} className="messages" {...feed.bind}>
      {sess?.summary && (
        <details className="memory">
          <summary><History size={11} />更早的对话已压缩成摘要</summary>
          <p>{sess.summary}</p>
        </details>
      )}
      {!list.length && !s.streaming && <Welcome />}
      {list.map((m) =>
        m.role === "user" ? (
          <UserMsg key={m.id} m={m} canEdit={!s.streaming && m.id === lastUser?.id} />
        ) : (
          <AssistantMsg key={m.id} m={m} isLast={m.id === lastAi?.id && list[list.length - 1]?.id === m.id} latestAsk={m.id === lastAi?.id && list[list.length - 1]?.id === m.id} />
        ),
      )}
      {s.streaming?.sessionId === s.sessionId && <StreamingMsg />}
    </div>{feed.showJump && <button type="button" className="messages-jump" onClick={feed.jumpToLatest}>回到最新消息</button>}</div>
  );
}

// ---------------- 输入区 ----------------
function QuickBar() {
  const quick = useStore((s) => s.quick);
  const busy = useStore((s) => !!s.streaming);
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
  };
  return (
    <div className="quickbar-wrap">
    <div className="quickbar" onWheel={onWheel}>
      {quick.map((q) => (
        <button key={q.id} type="button" className="quick" title={q.prompt} onClick={() => send(q.prompt, { quick: q.label })} disabled={busy && false}>
          <Zap size={11} />{q.label}
        </button>
      ))}
    </div>
      <button type="button" className="quick ghost" title="自定义快捷操作" onClick={() => setUi({ modal: "quick" })}><Settings2 size={11} /></button>
    </div>
  );
}

function Composer() {
  const ime = useImeGuard();
  const s = {
    streaming: useStore((st) => st.streaming),
    queue: useStore((st) => st.queue),
    skills: useStore((st) => st.skills),
    settings: useStore((st) => st.settings),
    selection: useStore((st) => st.selection),
  };
  const selKey = useStore((st) => (st.doc?.kind === "layout"
    ? st.doc.layout.items.map((x, i) => (st.selection.includes(x.id) ? `${x.id}\u0001${itemName(x, i)}` : "")).filter(Boolean).join("\u0002")
    : ""));
  const [text, setText] = useState("");
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [useSel, setUseSel] = useState(true);
  const [at, setAt] = useState<{ q: string; idx: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const atBtn = useAnchor();
  const selItems = useMemo(() => (selKey ? selKey.split("\u0002").map((p) => { const [id, name] = p.split("\u0001"); return { id, name }; }) : []), [selKey]);
  const skills = s.skills?.skills || [];
  const matches = at ? skills.filter((k) => k.name.toLowerCase().includes(at.q.toLowerCase())).slice(0, 8) : [];
  const slashQ = /^\/[a-z]*$/i.test(text) ? text.slice(1).toLowerCase() : null;
  const cmds = slashQ === null ? [] : SLASH.filter((c) => c.cmd.startsWith(slashQ));
  const runCmd = (cmd: string) => {
    setText("");
    if (cmd === "new") void startNewSession();
    else if (cmd === "clear") void askClear();
    else if (cmd === "draft") openDraft();
    else assistAgent();
  };
  useEffect(() => setUseSel(true), [s.selection.join(",")]);

  const upload = async (files: FileList | File[]) => {
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        if (!f.type.startsWith("image/")) continue;
        const a = await api.upload(f);
        setAtts((x) => [...x, a]);
      }
    } catch (e) {
      toast("上传失败：" + (e instanceof Error ? e.message : e), "err");
    } finally {
      setUploading(false);
    }
  };

  const pickSkill = (k: Skill) => {
    const el = ta.current;
    if (at && el) {
      const before = text.slice(0, at.idx);
      const after = text.slice(el.selectionStart);
      setText(`${before}@${k.name} ${after}`);
    }
    setSkillIds((x) => (x.includes(k.id) ? x : [...x, k.id]));
    setAt(null);
    setTimeout(() => ta.current?.focus(), 0);
  };

  const submit = () => {
    const t = text.trim();
    if (!t && !atts.length) return;
    const cmd = t.toLowerCase();
    if (!atts.length && SLASH.some((c) => "/" + c.cmd === cmd)) return runCmd(cmd.slice(1));
    const dm = /^\/(?:draft|起稿)\s+([\s\S]+)$/i.exec(t);
    if (dm && !atts.length) {
      if (quickDraft(dm[1].trim())) setText("");
      return;
    }
    send(t || "看看这张参考图", {
      attachments: atts, skillIds, selection: useSel ? selItems.map((x) => x.id) : [],
    });
    setText("");
    setAtts([]);
    setSkillIds([]);
    setAt(null);
  };

  const onChange = (v: string, caret: number) => {
    setText(v);
    const m = /(^|\s)@([^\s@]*)$/.exec(v.slice(0, caret));
    setAt(m ? { q: m[2], idx: caret - m[2].length - 1 } : null);
  };

  return (
    <div className="composer-wrap">
      {s.queue.length > 0 && (
        <div className="queue">
          {s.queue.map((q, i) => (
            <div key={q.id} className="queued">
              <span className="badge">排队 {i + 1}</span>
              <span className="ellipsis grow">{q.opts.quick || q.text}</span>
              <button type="button" className="btn btn-ghost btn-xs btn-icon" onClick={() => dropQueued(q.id)} title="取消"><X size={11} /></button>
            </div>
          ))}
        </div>
      )}
      <QuickBar />
      <ConversationComposer className={cx("composer", s.streaming && "busy")}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}>
        {(selItems.length > 0 || skillIds.length > 0 || atts.length > 0) && (
          <div className="composer-refs">
            {selItems.length > 0 && (
              <button type="button" className={cx("chip", useSel ? "accent" : "")} onClick={() => setUseSel(!useSel)} title={useSel ? "点击取消引用" : "点击引用选中的框"}>
                <MousePointerClick size={10} />{useSel ? "引用" : "不引用"}：{selItems.slice(0, 3).map((x) => x.name).join("、")}{selItems.length > 3 ? ` 等 ${selItems.length} 个` : ""}
              </button>
            )}
            {skillIds.map((id) => (
              <span key={id} className="chip"><AtSign size={10} />{skills.find((x) => x.id === id)?.name}
                <button type="button" onClick={() => setSkillIds((x) => x.filter((y) => y !== id))}><X size={10} /></button></span>
            ))}
            {atts.map((a) => (
              <span key={a.id} className="att">
                <img src={attachmentUrl(a.id)} alt={a.name} />
                <button type="button" onClick={() => setAtts((x) => x.filter((y) => y.id !== a.id))} title="移除"><X size={10} /></button>
              </span>
            ))}
          </div>
        )}
        <AutoTextarea
          ref={ta}
          className="composer-input"
          aria-label="给创作 Agent 的消息"
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          minRows={2}
          maxRows={9}
          value={text}
          placeholder={s.streaming ? "Agent 正在回复，现在发送会排队…" : "说说想怎么改，或问问建议（@ 引用 Skill · / 命令）"}
          onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
          onPaste={(e) => { const fs = Array.from(e.clipboardData.files); if (fs.length) { e.preventDefault(); void upload(fs); } }}
          onKeyDown={(e) => {
            if (ime.isComposing(e.nativeEvent)) return;
            if (at && matches.length && (e.key === "Enter" || e.key === "Tab")) { e.preventDefault(); pickSkill(matches[0]); return; }
            if (cmds.length && (e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); runCmd(cmds[0].cmd); return; }
            if (e.key === "Escape") setAt(null);
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
          }}
        />
        <Popover anchor={ta.current} open={cmds.length > 0} onClose={() => setText("")} above width={260}>
          <div className="menu-label">命令（Enter 执行）</div>
          {cmds.map((c) => <MenuItem key={c.cmd} icon={c.icon} meta={"/" + c.cmd} onClick={() => runCmd(c.cmd)}>{c.label}</MenuItem>)}
        </Popover>
        <Popover anchor={ta.current} open={!!at && matches.length > 0} onClose={() => setAt(null)} above width={260}>
          <div className="menu-label">引用 Skill</div>
          {matches.map((k) => <MenuItem key={k.id} icon={<AtSign size={13} />} meta={k.kind} onClick={() => pickSkill(k)}>{k.name}</MenuItem>)}
        </Popover>
        <div className="composer-foot">
          <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }} />
          <button type="button" className="btn btn-ghost btn-xs btn-icon" title="添加参考图（也可粘贴 / 拖入）" onClick={() => file.current?.click()}>
            {uploading ? <Loader2 size={13} className="spin" /> : <ImagePlus size={13} />}
          </button>
          <button ref={atBtn.ref} type="button" className="btn btn-ghost btn-xs btn-icon" title="引用 Skill" onClick={atBtn.toggle}><AtSign size={13} /></button>
          <Popover anchor={atBtn.ref.current} open={atBtn.open} onClose={atBtn.close} above width={260}>
            <div className="menu-label">引用 Skill</div>
            {skills.map((k) => <MenuItem key={k.id} icon={skillIds.includes(k.id) ? <Check size={13} /> : <AtSign size={13} />} meta={k.kind}
              onClick={() => { atBtn.close(); setSkillIds((x) => (x.includes(k.id) ? x.filter((y) => y !== k.id) : [...x, k.id])); }}>{k.name}</MenuItem>)}
          </Popover>
          <div className="spacer" />
          <span className="muted model-tag ellipsis" title="主模型（设置里可改，并可配置后备模型）">{s.settings?.model}</span>
          {s.streaming ? (
            <>
              {(text.trim() || atts.length > 0) && <button type="button" className="btn btn-sm" onClick={submit} title="加入队列">排队</button>}
              <button type="button" className="btn btn-sm stop-btn" onClick={stop} title="停止"><Square size={11} fill="currentColor" />停止</button>
            </>
          ) : (
            <button type="button" className="btn btn-sm btn-primary send-btn" disabled={!text.trim() && !atts.length} onClick={submit} title="发送 Enter">
              <ArrowUp size={14} />
            </button>
          )}
        </div>
      </ConversationComposer>
    </div>
  );
}

export function AgentPanel() {
  const seName = useStore((st) => currentSeries(st)?.name);
  const pageName = useStore((st) => currentPage(st)?.name);
  const kind = useStore((st) => st.doc?.kind);
  const autoApprove = useStore((st) => st.autoApprove);
  return (
    <aside className="panel right agent" aria-label="创作 Agent">
      <SessionTabs />
      <div className="agent-ctx">
        <span className="ctx-path ellipsis" title="Agent 看到的上下文">
          <b>{seName}</b><span className="muted"> / </span>{pageName}
          <span className="badge">{kind === "caption" ? "文稿" : "构图"}</span>
        </span>
        <div className="spacer" />
        <label className="row hint" title="Agent 的改动直接生效（仍可撤销 / 在记录里回滚）">
          <CheckCheck size={12} />自动采纳
          <Switch checked={autoApprove} onChange={setAutoApprove} />
        </label>
      </div>
      <MessageList />
      <Composer />
    </aside>
  );
}
