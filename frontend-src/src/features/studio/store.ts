import { create } from "zustand";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { api, putKeepalive, runAgent, type AgentEvent } from "./api";
import {
  alignGroupDepth, bodyOf, bringIntoView, cameraMoved, clampCamera, compileView, dragInView, estimateBodies, itemFromView, moveTargets, projectLayout, rebaseCamera,
  type CamHold, type MoveResult, type MoveScope,
} from "./lib/camera";
import { applyChanges, diffDocs } from "./lib/changeset";
import { normalizeLighting, presetById, presetLighting } from "./lib/lighting";
import { buildAssistPrompt, loadAssistPrefs, type AssistPrefs } from "./lib/assist";
import { clampBBox, clone, deepEqual, defaultCamera, expandGroups, fitItemsToCanvas, groupNumbers, itemName, newId, normalizeDoc, pruneGroups } from "./lib/doc";
import type {
  AppSettings, Ask, Attachment, BBox, Camera, CompileResult, Doc, ItemLabel, LayoutDraft, LayoutItem, Lighting, Message,
  Page, Proposal, Series, Session, SkillsState, Step,
} from "./types";

export type Modal = null | "settings" | "skills" | "reverse" | "archive" | "revisions" | "quick" | "draft";
export type Tool = "select" | "draw";

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "ok" | "err";
}

export interface QuickAction {
  id: string;
  label: string;
  prompt: string;
}

export const DEFAULT_QUICK: QuickAction[] = [
  { id: "q1", label: "补全描述", prompt: "检查整体描述和每个框，把空的、过短的或含糊的描述补全成具体、可画的描述；不要改框位和图层。" },
  { id: "q2", label: "检查问题", prompt: "检查当前页会导致编译失败或画面歧义的问题（空描述、文字框缺文字、框太小、重叠不合理、前后关系矛盾），列出来并直接修好。" },
  { id: "q3", label: "按视角改描述", prompt: "按当前镜头（机位、俯仰、朝向、景别）改写整体描述和各框描述：写清楚能看到哪一面、朝向和透视关系。不要改框位。" },
  { id: "q4", label: "整理图层", prompt: "按远近关系整理图层顺序（背景在前、前景在后），并给每个框起一个简短的中文名称。" },
  { id: "q5", label: "同系列新页", prompt: "基于当前页的角色设定和画风，在同一系列里新建一页变体构图（换一个机位或情节），写好完整布局。" },
  { id: "q7", label: "按灯光改描述", prompt: "按当前灯光设置（主光方向、色温、软硬、氛围）改写整体描述和各框描述：写清楚受光面、阴影落在哪一侧、高光和轮廓光的位置与颜色。不要改框位。" },
  { id: "q6", label: "写成 Caption", prompt: "把当前 Layout 写成一段完整连贯的 Caption 散文，写入当前页的 Caption。" },
];

export interface SendOpts {
  quick?: string | null;
  skillIds?: string[];
  attachments?: Attachment[];
  selection?: string[];
  replaceFromSeq?: number | null;
  /** 服务端运行模式：draft = AI 起稿 */
  mode?: string | null;
  /** 完成后自动采纳本轮改动（并切到被改动 / 新建的页面） */
  autoAccept?: boolean;
  /** 完成后自动编译 */
  compileAfter?: boolean;
}

export interface Streaming {
  sessionId: string;
  text: string;
  steps: Step[];
  pending: { name: string; label: string } | null;
  model: string;
  notices: string[];
  ask: Ask | null;
  error: string;
}

interface QueueItem {
  id: string;
  text: string;
  opts: SendOpts;
}

interface State {
  ready: boolean;
  bootError: string;
  series: Series[];
  seriesId: string;
  pageId: string;
  doc: Doc | null;
  saveState: "saved" | "pending" | "saving" | "error";
  undo: Doc[];
  redo: Doc[];
  selection: string[];
  tool: Tool;
  drawLabel: ItemLabel;
  showWire: boolean;
  freeCam: boolean;
  compileOpen: boolean;
  compiling: boolean;
  compileResult: CompileResult | null;
  compileError: string;
  compileStale: boolean;
  modal: Modal;
  toasts: Toast[];
  settings: AppSettings | null;
  skills: SkillsState | null;
  sessions: Session[];
  sessionId: string;
  messages: Record<string, Message[]>;
  streaming: Streaming | null;
  queue: QueueItem[];
  autoApprove: boolean;
  quick: QuickAction[];
  cameraPanelOpen: boolean;
  /** 全屏镜头调度 */
  director: boolean;
  /** 镜头视图里移动体块：自由 / 冻结（整体） */
  moveScope: MoveScope;
  /** 移动体块时镜头：固定 / 随主体 */
  moveHold: CamHold;
}

const S = {
  saveTimer: 0 as any,
  stateTimer: 0 as any,
  coalesceKey: "",
  coalesceAt: 0,
  checkpointAt: {} as Record<string, number>,
  abort: null as AbortController | null,
  toastId: 1,
};

const MOVE_KEY = "moss.move.prefs";
function loadMovePrefs(): { moveScope: MoveScope; moveHold: CamHold } {
  try {
    const v = JSON.parse(localStorage.getItem(MOVE_KEY) || "{}");
    return { moveScope: v.scope === "frozen" ? "frozen" : "free", moveHold: v.hold === "subject" ? "subject" : "fixed" };
  } catch {
    return { moveScope: "free", moveHold: "fixed" };
  }
}

export const useStore = create<State>(() => ({
  ready: false,
  bootError: "",
  series: [],
  seriesId: "",
  pageId: "",
  doc: null,
  saveState: "saved",
  undo: [],
  redo: [],
  selection: [],
  tool: "select",
  drawLabel: "object",
  showWire: true,
  freeCam: false,
  compileOpen: false,
  compiling: false,
  compileResult: null,
  compileError: "",
  compileStale: true,
  modal: null,
  toasts: [],
  settings: null,
  skills: null,
  sessions: [],
  sessionId: "",
  messages: {},
  streaming: null,
  queue: [],
  autoApprove: false,
  quick: DEFAULT_QUICK,
  cameraPanelOpen: true,
  director: false,
  ...loadMovePrefs(),
}));

const set = useStore.setState;
const get = useStore.getState;

/**
 * 编辑区组件用：订阅整个状态，但忽略 Agent 流式输出、提示条、排队这些高频字段。
 * 否则 Agent 每吐一个字，画布、左侧面板、顶栏都要整块重绘（相机开着时还要重算投影）。
 */
const VOLATILE = new Set<string>(["streaming", "toasts", "queue"]);
const sameWork = (a: State, b: State) => {
  if (a === b) return true;
  for (const k in a) {
    if (VOLATILE.has(k)) continue;
    if ((a as any)[k] !== (b as any)[k]) return false;
  }
  return true;
};
export function useWorkState(): State {
  return useStoreWithEqualityFn(useStore, (st) => st, sameWork);
}

// ---------- 编译结果自动刷新：抽屉开着时，文档改动 700ms 后自动重编 ----------
const AUTO_COMPILE_KEY = "moss.compile.auto";
export function autoCompileOn(): boolean {
  try {
    return localStorage.getItem(AUTO_COMPILE_KEY) !== "0";
  } catch {
    return true;
  }
}
export function setAutoCompile(v: boolean) {
  try {
    localStorage.setItem(AUTO_COMPILE_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (v) scheduleAutoCompile();
}
let autoCompileTimer: any = 0;
function scheduleAutoCompile() {
  clearTimeout(autoCompileTimer);
  autoCompileTimer = setTimeout(() => {
    const st = get();
    if (!st.compileOpen || !st.compileStale || !st.doc || !autoCompileOn()) return;
    if (st.compiling) return scheduleAutoCompile();
    void compileNow(false);
  }, 700);
}
useStore.subscribe((st, prev) => {
  if (st.compileOpen && st.compileStale && (st.doc !== prev.doc || st.compileOpen !== prev.compileOpen || st.compileStale !== prev.compileStale))
    scheduleAutoCompile();
});

// ---------- 小工具 ----------
export function toast(text: string, kind: Toast["kind"] = "info") {
  const id = S.toastId++;
  set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "err" ? 6000 : 3000);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function persistState() {
  clearTimeout(S.stateTimer);
  S.stateTimer = setTimeout(() => {
    const s = get();
    api.putState({
      seriesId: s.seriesId, pageId: s.pageId, sessionId: s.sessionId, autoApprove: s.autoApprove,
      quick: s.quick, showWire: s.showWire, cameraPanelOpen: s.cameraPanelOpen,
    }).catch(() => undefined);
  }, 400);
}

export const currentSeries = (s: State = get()) => s.series.find((x) => x.id === s.seriesId);
export const currentPage = (s: State = get()) => currentSeries(s)?.pages.find((p) => p.id === s.pageId);

function patchPageInTree(page: Partial<Page> & { id: string }) {
  set((s) => ({
    series: s.series.map((se) => ({
      ...se,
      pages: se.pages.map((p) => (p.id === page.id ? { ...p, ...page } : p)),
    })),
  }));
}

// ---------- 启动 ----------
export async function boot() {
  try {
    const [ws, settings, skills] = await Promise.all([api.workspace(), api.settings(), api.skills()]);
    const st = (ws.state || {}) as Record<string, any>;
    const series = ws.series.map((se) => ({ ...se, pages: se.pages.map((p) => ({ ...p, doc: normalizeDoc(p.doc) })) }));
    const se = series.find((x) => x.id === st.seriesId) || series[0];
    const page = se.pages.find((p) => p.id === st.pageId) || se.pages[0];
    set({
      series, seriesId: se.id, pageId: page.id, doc: clone(page.doc), settings, skills,
      autoApprove: !!st.autoApprove, quick: Array.isArray(st.quick) && st.quick.length ? st.quick : DEFAULT_QUICK,
      showWire: st.showWire !== false, cameraPanelOpen: st.cameraPanelOpen !== false, ready: true,
    });
    await loadSessions(se.id, st.sessionId);
  } catch (e) {
    set({ bootError: errText(e) });
  }
}

// ---------- 文档编辑 / 撤销 / 保存 ----------
export function commit(next: Doc, coalesce?: string) {
  const s = get();
  if (!s.doc || deepEqual(next, s.doc)) return;
  const now = Date.now();
  const merge = coalesce && coalesce === S.coalesceKey && now - S.coalesceAt < 900;
  S.coalesceKey = coalesce || "";
  S.coalesceAt = now;
  set({
    doc: next,
    undo: merge ? s.undo : [...s.undo.slice(-99), s.doc],
    redo: [],
    compileStale: true,
  });
  scheduleSave();
}

export function editLayout(fn: (d: LayoutDraft) => LayoutDraft, coalesce?: string) {
  const doc = get().doc;
  if (!doc) return;
  commit({ ...doc, layout: fn(clone(doc.layout)) }, coalesce);
}

export function undo() {
  const s = get();
  if (!s.doc || !s.undo.length) return;
  const prev = s.undo[s.undo.length - 1];
  S.coalesceKey = "";
  set({ doc: prev, undo: s.undo.slice(0, -1), redo: [...s.redo, s.doc], compileStale: true });
  scheduleSave();
}

export function redo() {
  const s = get();
  if (!s.doc || !s.redo.length) return;
  const nx = s.redo[s.redo.length - 1];
  S.coalesceKey = "";
  set({ doc: nx, redo: s.redo.slice(0, -1), undo: [...s.undo, s.doc], compileStale: true });
  scheduleSave();
}

function scheduleSave() {
  set({ saveState: "pending" });
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => void flushSave(), 600);
}

export async function flushSave(revision?: { source: string; summary?: string }) {
  clearTimeout(S.saveTimer);
  const s = get();
  if (!s.doc || !s.pageId) return;
  if (s.saveState === "saved" && !revision) return;
  const pid = s.pageId;
  const doc = s.doc;
  const now = Date.now();
  // 编辑一段时间后自动留一个“编辑前”的版本，便于回滚
  let rev = revision;
  if (!rev && now - (S.checkpointAt[pid] || 0) > 120000) rev = { source: "manual", summary: "" };
  if (rev) S.checkpointAt[pid] = now;
  set({ saveState: "saving" });
  try {
    await api.savePage(pid, { doc, revision: rev });
    patchPageInTree({ id: pid, doc });
    if (get().doc === doc) set({ saveState: "saved" });
  } catch (e) {
    set({ saveState: "error" });
    toast("保存失败：" + errText(e), "err");
  }
}

/** 窗口关闭 / 切到后台时：未保存的改动用 keepalive 同步发出 */
export function flushSaveOnExit() {
  const s = get();
  if (!s.doc || !s.pageId || s.saveState === "saved") return;
  clearTimeout(S.saveTimer);
  putKeepalive(`/api/pages/${s.pageId}`, { doc: s.doc });
}

// ---------- 系列 / 分页 ----------
export async function selectPage(pid: string) {
  const s = get();
  if (pid === s.pageId) return;
  await flushSave();
  const se = s.series.find((x) => x.pages.some((p) => p.id === pid));
  const page = se?.pages.find((p) => p.id === pid);
  if (!se || !page) return;
  const seriesChanged = se.id !== s.seriesId;
  set({
    seriesId: se.id, pageId: pid, doc: clone(page.doc), undo: [], redo: [], selection: [], compileStale: true,
    compileResult: null, compileError: "", freeCam: false, director: false, saveState: "saved",
  });
  if (seriesChanged) await loadSessions(se.id);
  persistState();
}

export async function addPage(opts: { name?: string; doc?: Doc; kind?: Doc["kind"] } = {}) {
  const s = get();
  const cur = s.doc;
  const p = await api.createPage({
    series_id: s.seriesId, name: opts.name, doc: opts.doc,
    kind: opts.kind || cur?.kind, width: cur?.layout.width, height: cur?.layout.height,
  });
  p.doc = normalizeDoc(p.doc);
  set((st) => ({ series: st.series.map((se) => (se.id === s.seriesId ? { ...se, pages: [...se.pages, p] } : se)) }));
  await selectPage(p.id);
  return p;
}

export async function duplicatePage(pid: string) {
  await flushSave();
  const p = await api.duplicatePage(pid);
  p.doc = normalizeDoc(p.doc);
  set((st) => ({ series: st.series.map((se) => (se.id === p.series_id ? { ...se, pages: [...se.pages, p] } : se)) }));
  await selectPage(p.id);
}

export async function renamePage(pid: string, name: string) {
  await api.savePage(pid, { name });
  patchPageInTree({ id: pid, name });
}

export async function deletePage(pid: string) {
  await api.deletePage(pid);
  const ws = await api.workspace();
  const series = ws.series.map((se) => ({ ...se, pages: se.pages.map((p) => ({ ...p, doc: normalizeDoc(p.doc) })) }));
  set({ series });
  if (get().pageId === pid) {
    const se = series.find((x) => x.id === get().seriesId) || series[0];
    set({ pageId: "" });
    await selectPage(se.pages[0].id);
  }
}

export async function addSeries(name: string) {
  await flushSave();
  const se = await api.createSeries(name);
  se.pages = se.pages.map((p) => ({ ...p, doc: normalizeDoc(p.doc) }));
  set((st) => ({ series: [...st.series, se] }));
  await selectPage(se.pages[0].id);
}

export async function renameSeries(id: string, name: string) {
  await api.renameSeries(id, name);
  set((st) => ({ series: st.series.map((se) => (se.id === id ? { ...se, name } : se)) }));
}

export async function deleteSeries(id: string) {
  await api.deleteSeries(id);
  const ws = await api.workspace();
  const series = ws.series.map((se) => ({ ...se, pages: se.pages.map((p) => ({ ...p, doc: normalizeDoc(p.doc) })) }));
  set({ series, pageId: "" });
  await selectPage(series[0].pages[0].id);
  await loadSessions(series[0].id);
}

/** 用外部文档（档案库 / 反推 / 版本）替换当前页，可撤销 */
export async function replaceCurrentDoc(doc: Doc, source: string, summary: string) {
  const cur = get().doc;
  if (!cur) return;
  commit(normalizeDoc(doc));
  await flushSave({ source, summary });
}

// ---------- 框操作 ----------
export function select(ids: string[]) {
  set({ selection: ids });
}

export function addItem(bbox: number[], label?: ItemLabel, extra?: Partial<LayoutItem>, camera?: Camera) {
  const doc = get().doc;
  if (!doc) return;
  const L = doc.layout;
  const id = newId();
  const lab = label || get().drawLabel;
  const used = new Set(L.items.map((x) => x.color));
  let color = L.items.length % 6;
  for (let c = 0; c < 6; c++) if (!used.has(c)) { color = c; break; }
  // 移过机位后画的世界框：bbox 是基准机位下的位置，可能在画布外，不能夹到画布里
  const world = !!extra?.body && (extra.body.anchor || "world") === "world" && cameraMoved(L);
  const it: LayoutItem = {
    id, label: lab, caption: "", bbox: world ? (bbox.map((v) => Math.round(v)) as LayoutItem["bbox"]) : clampBBox(bbox, L.width, L.height), color, depth: "auto",
    ...(lab === "text" ? { text: "" } : {}),
    ...(extra || {}),
  };
  editLayout((d) => ({ ...d, items: [...d.items, it], ...(camera ? { camera } : {}) }));
  set({ selection: [id] });
  return id;
}

/** 在镜头视图里画的框：按当前机位反推成 3D 体块（主体变了同时补偿机位，画面不跳） */
export function addItemInView(rect: BBox, start?: { x: number; y: number }, label?: ItemLabel) {
  const doc = get().doc;
  if (!doc) return;
  const lab = label || get().drawLabel;
  const r = itemFromView(doc.layout, rect, lab, start);
  if (!r) return addItem(rect, lab);
  return addItem(r.bbox, lab, { body: r.body }, r.camera);
}

export function updateItem(id: string, patch: Partial<LayoutItem>, coalesce?: string) {
  editLayout((d) => ({ ...d, items: d.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) }), coalesce);
}

export function updateItems(patches: Record<string, Partial<LayoutItem>>, coalesce?: string) {
  editLayout((d) => ({ ...d, items: d.items.map((it) => (patches[it.id] ? { ...it, ...patches[it.id] } : it)) }), coalesce);
}

export function removeItems(ids: string[]) {
  const doc = get().doc;
  if (!doc || !ids.length) return;
  const del = new Set(ids.filter((id) => !doc.layout.items.find((x) => x.id === id)?.locked));
  if (!del.size) return toast("锁定的框不能删除");
  editLayout((d) => ({ ...d, items: pruneGroups(d.items.filter((it) => !del.has(it.id))) }));
  set({ selection: [] });
}

export function duplicateItems(ids: string[]) {
  const doc = get().doc;
  if (!doc) return;
  const fresh: string[] = [];
  editLayout((d) => {
    const items = [...d.items];
    // 整组一起复制：副本成一个新组；只复制组里的一个：副本留在原组
    const whole = new Map<string, string>();
    for (const it of d.items)
      if (it.group && !whole.has(it.group) && d.items.filter((x) => x.group === it.group).every((x) => ids.includes(x.id))) whole.set(it.group, newId("g"));
    for (const id of ids) {
      const src = items.find((x) => x.id === id);
      if (!src) continue;
      const nid = newId();
      fresh.push(nid);
      const [x1, y1, x2, y2] = src.bbox;
      const copy: LayoutItem = { ...clone(src), id: nid, locked: false, name: src.name ? src.name + " 副本" : undefined,
        bbox: clampBBox([x1 + 24, y1 + 24, x2 + 24, y2 + 24], d.width, d.height) };
      if (src.group && whole.has(src.group)) copy.group = whole.get(src.group);
      items.push(copy);
    }
    return { ...d, items };
  });
  set({ selection: fresh });
}

export function reorder(ids: string[], op: "up" | "down" | "top" | "bottom") {
  editLayout((d) => {
    const items = [...d.items];
    const sel = new Set(ids);
    if (op === "top" || op === "bottom") {
      const picked = items.filter((x) => sel.has(x.id));
      const rest = items.filter((x) => !sel.has(x.id));
      return { ...d, items: op === "top" ? [...rest, ...picked] : [...picked, ...rest] };
    }
    if (op === "up") {
      for (let i = items.length - 2; i >= 0; i--)
        if (sel.has(items[i].id) && !sel.has(items[i + 1].id)) [items[i], items[i + 1]] = [items[i + 1], items[i]];
    } else {
      for (let i = 1; i < items.length; i++)
        if (sel.has(items[i].id) && !sel.has(items[i - 1].id)) [items[i], items[i - 1]] = [items[i - 1], items[i]];
    }
    return { ...d, items };
  });
}

export function moveItemTo(id: string, toIndex: number) {
  editLayout((d) => {
    const items = [...d.items];
    const from = items.findIndex((x) => x.id === id);
    if (from < 0) return d;
    const [it] = items.splice(from, 1);
    items.splice(Math.max(0, Math.min(items.length, toIndex)), 0, it);
    return { ...d, items };
  });
}

export function setCanvasSize(W: number, H: number, fit = true) {
  editLayout((d) => (fit ? fitItemsToCanvas(d, W, H) : { ...d, width: W, height: H, items: d.items.map((it) => ({ ...it, bbox: clampBBox(it.bbox, W, H) })) }));
}

// ---------- 成组 ----------
/** 画布上点一个框：同组的一起选中（按住 Alt 只选它自己） */
export function withGroup(ids: string[], solo = false): string[] {
  const d = get().doc?.layout;
  if (!d || solo) return ids;
  return expandGroups(d.items, ids);
}

/** 选中的框成组（Ctrl+G）。和组里更大的成员重叠的框（手持物等）会对齐远近，转镜头时不再分开 */
export function groupSelection() {
  const s = get();
  const d = s.doc?.layout;
  if (!d) return;
  const ids = expandGroups(d.items, s.selection);
  if (ids.length < 2) return toast("至少选两个框才能成组（Shift 点选多个）");
  const flat = d.items.filter((x) => ids.includes(x.id) && bodyOf(x, d).anchor !== "world");
  if (flat.length) toast(`${flat.map((x) => itemName(x)).join("、")} 贴在画面上（文字 / 背景板），不随镜头动；成组后只在初始机位下一起移动`);
  const gid = newId("g");
  const al = alignGroupDepth(d, ids);
  editLayout((x) => ({
    ...x,
    items: pruneGroups(x.items.map((it) => (ids.includes(it.id) ? { ...it, ...(al.patches[it.id] || {}), group: gid } : it))),
  }));
  set({ selection: ids });
  const L = get().doc!.layout;
  const no = groupNumbers(L.items).get(gid);
  const name = (id: string) => { const k = L.items.findIndex((x) => x.id === id); return k >= 0 ? itemName(L.items[k], k) : id; };
  toast(al.aligned.length
    ? `已成组（组 ${no}）；${al.aligned.map((a) => `「${name(a.id)}」`).join("")}的远近已对齐到「${name(al.aligned[0].to)}」`
    : `已成组（组 ${no}）：移动、转镜头时 ${ids.length} 个框保持一体`, "ok");
}

/** 解散选中框所在的组（Ctrl+Shift+G） */
export function ungroupSelection() {
  const s = get();
  const d = s.doc?.layout;
  if (!d) return;
  const groups = new Set(d.items.filter((x) => s.selection.includes(x.id) && x.group).map((x) => x.group!));
  if (!groups.size) return toast("选中的框不在组里");
  editLayout((x) => ({
    ...x,
    items: x.items.map((it) => {
      if (!it.group || !groups.has(it.group)) return it;
      const { group: _g, ...rest } = it; // eslint-disable-line @typescript-eslint/no-unused-vars
      return rest as LayoutItem;
    }),
  }));
  toast(groups.size > 1 ? `已解散 ${groups.size} 个组` : "已解组", "ok");
}

/** 组内重新对齐远近 */
export function alignGroup(ids: string[]) {
  const d = get().doc?.layout;
  if (!d) return;
  const al = alignGroupDepth(d, ids);
  if (!al.aligned.length) return toast("组内远近已经一致（只对齐和更大成员重叠的框）");
  updateItems(al.patches);
  toast(`已对齐 ${al.aligned.length} 个框的远近`, "ok");
}

// ---------- 镜头视图里移动体块 ----------
export function setMovePrefs(p: Partial<{ moveScope: MoveScope; moveHold: CamHold }>) {
  set(p);
  const s = get();
  try {
    localStorage.setItem(MOVE_KEY, JSON.stringify({ scope: s.moveScope, hold: s.moveHold }));
  } catch {
    /* ignore */
  }
}

/** 一次性写入移动结果（框 + 机位），coalesce 相同的连续调用合成一步撤销 */
export function applyMove(r: MoveResult | null, coalesce?: string) {
  if (!r) return;
  editLayout((d) => ({
    ...d,
    items: d.items.map((it) => (r.patches[it.id] ? { ...it, ...r.patches[it.id] } : it)),
    ...(r.camera ? { camera: r.camera } : {}),
  }), coalesce);
}

/** 镜头视图里按画面方向微移选中的框（方向键） */
export function nudgeInView(dx: number, dy: number, solo = false) {
  const s = get();
  const L = s.doc?.layout;
  if (!L || !s.selection.length) return;
  const grab = s.selection[0];
  const t = moveTargets(L, s.selection, s.moveScope, grab, solo);
  if (!t.ids.length) return toast(t.pinned ? "锁定的框（或组里有锁定的框）不能移动" : "没有可移动的框");
  applyMove(dragInView(L, grab, t.ids, dx, dy, s.moveHold), "nudge");
}

/** 拉回画面：镜头不动，把框（连同同组的框）挪进当前画面 */
export function bringIntoFrame(id: string, quiet = false, coalesce?: string): boolean {
  const L = get().doc?.layout;
  if (!L) return false;
  const t = moveTargets(L, [id], "free", id);
  if (!t.ids.includes(id)) {
    if (!quiet) toast("锁定的框（或组里有锁定的框）不能移动");
    return false;
  }
  const r = bringIntoView(L, id, t.ids);
  if (!r) {
    if (!quiet) toast("它已经在画面里了");
    return false;
  }
  applyMove(r, coalesce);
  return true;
}

/** 把出画的 3D 体块逐个拉回画面（includePartial：部分出画的也收进来） */
export function bringAllIntoFrame(includePartial = false) {
  const L = get().doc?.layout;
  if (!L) return;
  const pr = projectLayout(L);
  const done = new Set<string>();
  const key = `bring${Date.now()}`;
  let n = 0;
  for (const it of L.items) {
    const p = pr.items[it.id];
    if (it.hidden || it.locked || done.has(it.id) || !p || p.anchor !== "world") continue;
    const fully = p.visible && !p.partial && !!p.corners?.every(Boolean);
    if (includePartial ? fully : p.visible) continue;
    for (const id of expandGroups(L.items, [it.id])) done.add(id);
    if (bringIntoFrame(it.id, true, key)) n++;
  }
  toast(n ? `已把 ${n} 个出画的框（组）拉回画面，镜头没动` : "没有能拉回的框", n ? "ok" : "info");
}

// ---------- 摄像机 ----------
export function setCamera(patch: Partial<Camera>, coalesce = "camera") {
  editLayout((d) => ({ ...d, camera: clampCamera({ ...(d.camera || defaultCamera()), ...patch }) }), coalesce);
}

export function toggleCamera(on?: boolean) {
  const d = get().doc?.layout;
  if (!d) return;
  const enabled = on ?? !d.camera?.enabled;
  editLayout((x) => {
    const withBodies = enabled ? estimateBodies(x, true) : x;
    return { ...withBodies, camera: { ...(x.camera || defaultCamera()), enabled } };
  });
  if (!enabled) set({ freeCam: false, director: false });
}

/** 打开全屏镜头调度（摄像机没开就先开） */
export function openDirector() {
  const d = get().doc;
  if (!d || d.kind !== "layout") return;
  if (!d.layout.camera?.enabled) toggleCamera(true);
  set({ director: true, freeCam: false, modal: null });
}

export function resetCamera() {
  editLayout((d) => ({ ...d, camera: { ...defaultCamera(), enabled: !!d.camera?.enabled } }));
}

export function bakeCamera() {
  const d = get().doc?.layout;
  if (!d || !cameraMoved(d)) return toast("当前就是初始机位");
  editLayout((x) => rebaseCamera(x));
  toast("已把当前机位定为基准", "ok");
}

export function reestimateBodies() {
  editLayout((d) => estimateBodies(d));
  toast("已按框的位置与大小重新估算体块", "ok");
}

// ---------- 灯光 ----------
export function setLighting(patch: Partial<Lighting> | ((lg: Lighting) => Partial<Lighting>), coalesce = "lighting") {
  editLayout((d) => {
    const cur = normalizeLighting(d.lighting);
    const p = typeof patch === "function" ? patch(cur) : patch;
    return { ...d, lighting: normalizeLighting({ ...cur, ...p }) };
  }, coalesce);
}

export function applyLightingPreset(id: string) {
  const p = presetById(id);
  if (!p) return;
  editLayout((d) => ({ ...d, lighting: presetLighting(id, d.camera, normalizeLighting(d.lighting)), prompt_options: { depth: true, perspective: false, camera: true, ...d.prompt_options, lighting: true } }));
}

/** 切换「灯光跟随镜头」：保持当前画面里的光向不变，换算方位 */
export function setLightingFollow(follow: boolean) {
  editLayout((d) => {
    const lg = normalizeLighting(d.lighting);
    if (lg.follow === follow) return d;
    const o = d.camera?.enabled ? d.camera.orbit || 0 : 0;
    const k = follow ? -o : o;
    const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
    return { ...d, lighting: normalizeLighting({ ...lg, follow, lights: lg.lights.map((l) => ({ ...l, azimuth: wrap(l.azimuth + k) })) }) };
  });
}

// ---------- AI 起稿 ----------
export interface DraftOpts {
  text: string;
  canvas: "keep" | "ai" | { w: number; h: number };
  mode: "replace" | "append" | "page";
  camera: boolean;
  lighting: boolean;
  autoAccept: boolean;
}

export function buildDraftPrompt(o: DraftOpts, doc: Doc): string {
  const L = doc.layout;
  const lines = [`【AI 起稿】根据下面的画面描述生成完整布局（定位框 + 每个框的描述 + 整体描述）。`, "", `画面描述：${o.text.trim()}`, ""];
  lines.push(
    o.mode === "replace" ? "写入方式：替换当前页的布局（replace_layout）。"
      : o.mode === "append" ? "写入方式：追加到当前页（add_items），已有的框不要动。"
        : "写入方式：在当前系列新建一页（create_page），再在新页写布局。",
  );
  if (o.mode === "append") lines.push(`画布：保持当前 ${L.width}×${L.height}。`);
  else if (o.canvas === "ai") lines.push("画布：由 AI 决定（按内容选竖幅 / 横幅 / 方形）。");
  else if (o.canvas === "keep") lines.push(`画布：保持当前 ${L.width}×${L.height}。`);
  else lines.push(`画布：${o.canvas.w}×${o.canvas.h}（resize_canvas=true）。`);
  lines.push(o.camera ? "机位：打开摄像机，按描述设置机位（没提就平视）。" : "机位：不用设置。");
  lines.push(o.lighting ? "灯光：按场景选合适的打光预设并打开灯光。" : "灯光：不用设置。");
  return lines.join("\n");
}

export function draftLayout(o: DraftOpts): boolean {
  const s = get();
  if (!s.doc || !o.text.trim()) return false;
  if (s.settings && !s.settings.api_key_set) {
    toast("先在「设置」里填写接口地址和 API Key，才能 AI 起稿", "err");
    set({ modal: "settings" });
    return false;
  }
  if (s.doc.kind !== "layout" && o.mode !== "page") {
    toast("当前是 Caption 页，起稿会新建一页 Layout", "info");
    o = { ...o, mode: "page" };
  }
  if (s.streaming) toast("Agent 正在回复，已加入队列", "info");
  send(buildDraftPrompt(o, s.doc), { quick: "AI 起稿", mode: "draft", autoAccept: o.autoAccept, compileAfter: o.autoAccept, selection: [] });
  return true;
}

// ---------- 编译 ----------
export async function compileNow(open = true) {
  const s = get();
  if (!s.doc) return;
  set({ compiling: true, compileOpen: open || s.compileOpen });
  try {
    const draft = s.doc.kind === "layout" ? s.doc.layout : s.doc.caption;
    const view = s.doc.kind === "layout" ? compileView(s.doc.layout) : undefined;
    const r = await api.compile(draft, view);
    set({ compileResult: r, compileError: "", compileStale: get().doc !== s.doc });
  } catch (e) {
    set({ compileError: errText(e), compileResult: null, compileStale: get().doc !== s.doc });
  } finally {
    set({ compiling: false });
  }
}

// ---------- Agent 会话 ----------
export async function loadSessions(seriesId: string, prefer?: string) {
  let sessions = await api.sessions(seriesId);
  let open = sessions.filter((x) => !x.closed);
  if (!open.length) {
    const ns = await api.createSession(seriesId);
    sessions = [...sessions, ns];
    open = [ns];
  }
  const sid = open.find((x) => x.id === prefer)?.id || open[open.length - 1].id;
  set({ sessions, sessionId: sid });
  await loadMessages(sid);
}

export async function loadMessages(sid: string) {
  const msgs = await api.messages(sid);
  set((s) => ({ messages: { ...s.messages, [sid]: msgs } }));
}

export async function openSession(sid: string) {
  const s = get();
  const sess = s.sessions.find((x) => x.id === sid);
  if (sess?.closed) {
    const u = await api.patchSession(sid, { closed: false });
    set((st) => ({ sessions: st.sessions.map((x) => (x.id === sid ? u : x)) }));
  }
  set({ sessionId: sid });
  if (!get().messages[sid]) await loadMessages(sid);
  persistState();
}

export async function newSession() {
  const s = get();
  const empty = s.sessions.find((x) => !x.closed && x.title === "新对话" && !(s.messages[x.id] || []).length);
  if (empty) return openSession(empty.id);
  const ns = await api.createSession(s.seriesId);
  set((st) => ({ sessions: [...st.sessions, ns], sessionId: ns.id, messages: { ...st.messages, [ns.id]: [] } }));
  persistState();
}

export async function closeSession(sid: string) {
  const u = await api.patchSession(sid, { closed: true });
  set((st) => ({ sessions: st.sessions.map((x) => (x.id === sid ? u : x)) }));
  const s = get();
  if (s.sessionId === sid) {
    const open = s.sessions.filter((x) => !x.closed);
    if (open.length) await openSession(open[open.length - 1].id);
    else await newSession();
  }
}

export async function renameSession(sid: string, title: string) {
  const u = await api.patchSession(sid, { title });
  set((st) => ({ sessions: st.sessions.map((x) => (x.id === sid ? u : x)) }));
}

export async function deleteSession(sid: string) {
  await api.deleteSession(sid);
  set((st) => ({ sessions: st.sessions.filter((x) => x.id !== sid) }));
  if (get().sessionId === sid) {
    const open = get().sessions.filter((x) => !x.closed);
    if (open.length) await openSession(open[open.length - 1].id);
    else await newSession();
  }
}

/** 清空对话：删除消息、摘要和已读快照，标题回到“新对话”。页面内容不动。 */
export async function clearSession(sid: string = get().sessionId) {
  const s = get();
  if (s.streaming?.sessionId === sid) {
    S.abort?.abort();
    await new Promise((r) => setTimeout(r, 400));
  }
  const u = await api.clearSession(sid);
  set((st) => ({
    sessions: st.sessions.map((x) => (x.id === sid ? u : x)),
    messages: { ...st.messages, [sid]: [] },
    queue: st.queue.length && st.sessionId === sid ? [] : st.queue,
  }));
  toast("已清空当前对话", "ok");
}

/** 开新对话（已有空白对话时直接切过去） */
export async function startNewSession() {
  const s = get();
  const cur = s.sessions.find((x) => x.id === s.sessionId);
  if (cur && cur.title === "新对话" && !(s.messages[cur.id] || []).length && !s.streaming) {
    toast("已经是新对话", "info");
    return;
  }
  await newSession();
}

/** 当前页还没处理的 Agent 改动（任意会话里最新的一条） */
export function pendingProposalFor(s: State, pageId: string): { messageId: string; proposal: Proposal } | null {
  let best: { messageId: string; proposal: Proposal; at: string } | null = null;
  for (const list of Object.values(s.messages)) {
    for (const m of list) {
      for (const p of m.meta?.proposals || []) {
        if (p.page_id === pageId && p.status === "pending" && (!best || (m.created_at || "") > best.at))
          best = { messageId: m.id, proposal: p, at: m.created_at || "" };
      }
    }
  }
  return best ? { messageId: best.messageId, proposal: best.proposal } : null;
}

function patchMessage(msg: Message) {
  set((s) => ({
    messages: { ...s.messages, [msg.session_id]: (s.messages[msg.session_id] || []).map((m) => (m.id === msg.id ? msg : m)) },
  }));
}

export async function resolveProposal(messageId: string, pageId: string, status: "accepted" | "rejected" | "partial", keys?: Set<string>) {
  const s = get();
  const msg = Object.values(s.messages).flat().find((m) => m.id === messageId);
  const prop = msg?.meta.proposals?.find((p) => p.page_id === pageId);
  if (!msg || !prop) return;
  const isCurrent = pageId === s.pageId && !!s.doc;
  let applied: Doc | undefined;
  if (status !== "rejected") {
    const base = normalizeDoc(prop.base);
    const proposed = normalizeDoc(prop.proposed);
    const target = isCurrent ? s.doc! : normalizeDoc(s.series.flatMap((x) => x.pages).find((p) => p.id === pageId)?.doc);
    const all = status === "accepted" && deepEqual(target, base);
    applied = all ? proposed : applyChanges(target, base, proposed, keys || new Set(diffKeys(base, proposed)));
  }
  if (isCurrent) await flushSave();
  try {
    const r = await api.resolveProposal(messageId, { page_id: pageId, status, applied_doc: applied });
    patchMessage(r.message);
    if (r.page) {
      const doc = normalizeDoc(r.page.doc);
      patchPageInTree({ id: pageId, doc, name: r.page.name });
      if (get().pageId === pageId && applied) {
        const cur = get().doc!;
        set({ doc, undo: [...get().undo.slice(-99), cur], redo: [], compileStale: true, saveState: "saved" });
      }
    }
    if (status !== "rejected") toast(status === "partial" ? "已采纳所选改动" : "已采纳改动", "ok");
  } catch (e) {
    toast("处理改动失败：" + errText(e), "err");
  }
}

const diffKeys = (a: Doc, b: Doc) => diffDocs(a, b).map((c) => c.key);

// ---------- Agent 运行 ----------
export function send(text: string, opts: SendOpts = {}) {
  const s = get();
  if (!text.trim() && !opts.attachments?.length) return;
  if (s.streaming) {
    set({ queue: [...s.queue, { id: newId("q"), text, opts }] });
    return;
  }
  void run(text, opts);
}

/** 一键交给 Agent 补全提示词。返回 false 表示没发出去（没配置 Key 等）。 */
export function assistAgent(opts: { prefs?: AssistPrefs; note?: string } = {}): boolean {
  const s = get();
  if (!s.doc) return false;
  if (s.settings && !s.settings.api_key_set) {
    toast("先在「设置」里填写接口地址和 API Key，Agent 才能补全", "err");
    set({ modal: "settings" });
    return false;
  }
  const prefs = opts.prefs || loadAssistPrefs();
  const text = buildAssistPrompt(s.doc, prefs, s.selection, opts.note || "");
  const sel = s.doc.kind === "layout" && prefs.onlySel ? s.selection : [];
  const label = s.doc.kind === "caption" ? "补全 Caption" : prefs.onlySel && sel.length ? `补全提示词 · 选中 ${sel.length} 个` : "补全提示词";
  if (s.streaming) toast("Agent 正在回复，已加入队列", "info");
  send(text, { quick: label, selection: sel });
  return true;
}

export function dropQueued(id: string) {
  set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
}

export function stop() {
  S.abort?.abort();
}

export function setAutoApprove(v: boolean) {
  set({ autoApprove: v });
  persistState();
}

export function setQuick(q: QuickAction[]) {
  set({ quick: q });
  persistState();
}

export function setUi(patch: Partial<Pick<State, "showWire" | "cameraPanelOpen" | "compileOpen" | "tool" | "drawLabel" | "freeCam" | "modal" | "director">>) {
  set(patch);
  if ("showWire" in patch || "cameraPanelOpen" in patch) persistState();
}

async function run(text: string, opts: SendOpts) {
  const s0 = get();
  if (!s0.doc) return;
  await flushSave();
  const s = get();
  const sid = s.sessionId;
  const doc = s.doc!;
  const view = doc.kind === "layout" ? compileView(doc.layout) : undefined;
  const temp: Message = {
    id: "tmp-user", session_id: sid, seq: 1e9, role: "user", content: text,
    meta: { page_id: s.pageId, selection: opts.selection || [], skill_ids: opts.skillIds || [],
      attachments: (opts.attachments || []).map((a) => a.id), quick: opts.quick || null },
  };
  const keep = (s.messages[sid] || []).filter((m) => !opts.replaceFromSeq || m.seq < opts.replaceFromSeq);
  set({
    messages: { ...s.messages, [sid]: [...keep, temp] },
    streaming: { sessionId: sid, text: "", steps: [], pending: null, model: "", notices: [], ask: null, error: "" },
  });
  const ctrl = new AbortController();
  S.abort = ctrl;
  const upd = (fn: (st: Streaming) => Partial<Streaming>) =>
    set((st) => (st.streaming ? { streaming: { ...st.streaming, ...fn(st.streaming) } } : {}));
  let final: Message | null = null;
  const onEvent = (e: AgentEvent) => {
    switch (e.type) {
      case "user_saved":
        set((st) => ({ messages: { ...st.messages, [sid]: (st.messages[sid] || []).map((m) => (m.id === "tmp-user" ? e.message : m)) } }));
        break;
      case "model":
        upd(() => ({ model: e.model }));
        break;
      case "text":
        upd((st) => ({ text: st.text + e.delta }));
        break;
      case "tool_pending":
        upd(() => ({ pending: { name: e.name, label: e.label } }));
        break;
      case "tool":
        upd((st) => ({ pending: null, steps: [...st.steps, { name: e.name, label: e.label, brief: e.brief, ok: e.ok, result: e.result }] }));
        break;
      case "ask":
        upd(() => ({ ask: { question: e.question, options: e.options, multi: e.multi } }));
        break;
      case "page_created": {
        const p = { ...e.page, doc: normalizeDoc(e.page.doc) };
        set((st) => ({
          series: st.series.map((se) => (se.id === p.series_id && !se.pages.some((x) => x.id === p.id) ? { ...se, pages: [...se.pages, p] } : se)),
        }));
        upd((st) => ({ steps: [...st.steps, { name: "create_page", label: "新建页面", brief: p.name, ok: true }] }));
        break;
      }
      case "notice":
        upd((st) => ({ notices: [...st.notices, e.message] }));
        break;
      case "error":
        upd(() => ({ error: e.message }));
        break;
      case "done":
        final = e.message;
        break;
    }
  };
  try {
    await runAgent(sid, {
      page_id: s.pageId, doc, view, message: text, selection: opts.selection || [], skill_ids: opts.skillIds || [],
      attachments: (opts.attachments || []).map((a) => a.id), replace_from_seq: opts.replaceFromSeq ?? null,
      quick: opts.quick ?? null, mode: opts.mode ?? null,
    }, onEvent, ctrl.signal);
  } catch (e) {
    if (!ctrl.signal.aborted) {
      const msg = errText(e);
      upd(() => ({ error: msg }));
      toast("Agent 出错：" + msg, "err");
    }
  }
  const stoppedErr = get().streaming?.error;
  if (ctrl.signal.aborted) await new Promise((r) => setTimeout(r, 350));
  S.abort = null;
  try {
    await loadMessages(sid);
  } catch {
    /* 离线时保留本地 */
  }
  const sess = await api.sessions(get().seriesId).catch(() => null);
  set({ streaming: null, ...(sess ? { sessions: sess } : {}) });
  if (!final && stoppedErr && !ctrl.signal.aborted) {
    // 请求没到达服务端：保留错误提示
  }
  // 自动采纳
  const fm = final as Message | null;
  if (fm && (get().autoApprove || opts.autoAccept)) {
    const props = (fm.meta.proposals || []).filter((p) => p.status === "pending");
    for (const p of props) await resolveProposal(fm.id, p.page_id, "accepted");
    if (opts.autoAccept && props.length) {
      const target = props.find((p) => p.page_id !== get().pageId && get().series.some((se) => se.pages.some((x) => x.id === p.page_id)));
      if (target && props.every((p) => p.page_id !== get().pageId)) await selectPage(target.page_id);
      if (opts.compileAfter && get().doc?.kind === "layout") void compileNow(false);
    }
  }
  const q = get().queue;
  if (q.length) {
    const [head, ...rest] = q;
    set({ queue: rest });
    void run(head.text, head.opts);
  }
}

export function lastUserMessage(sid: string): Message | undefined {
  const list = get().messages[sid] || [];
  return [...list].reverse().find((m) => m.role === "user");
}

export function rerun(m: Message, newText?: string) {
  const meta = m.meta || {};
  send(newText ?? m.content, {
    replaceFromSeq: m.seq, quick: meta.quick, skillIds: meta.skill_ids, selection: meta.selection,
    mode: meta.quick === "AI 起稿" ? "draft" : null,
    attachments: (meta.attachments || []).map((id) => ({ id, name: id, mime: "image/*" })),
  });
}

export function isBusy() {
  return !!get().streaming;
}

export { compileView };
