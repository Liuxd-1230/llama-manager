import {
  Box, Camera as CameraIcon, Check, ClipboardCopy, Hand, Maximize, Minus, MousePointer2, Move3d, Play, Plus, RefreshCw,
  Save, SquareDashed, Type, User, X, AlertTriangle, Loader2, ChevronDown, Clapperboard, Link2, Magnet, Sparkles, ArrowUp,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { cameraMoved, dragInView, moveTargets, projectLayout, type Projection } from "../lib/camera";
import { diffDocs } from "../lib/changeset";
import { boxColor, clampBBox, groupNumbers, itemName, normalizeDoc } from "../lib/doc";
import {
  addItem, addItemInView, applyMove, autoCompileOn, bringAllIntoFrame, commit, compileNow, openDirector, pendingProposalFor, resolveProposal, select, setAutoCompile,
  setCamera, setUi, toast, updateItems, useStore, useWorkState, withGroup,
} from "../store";
import type { BBox, ItemLabel, LayoutDraft, LayoutItem } from "../types";
import { LABEL_TEXT } from "../types";
import { Seg, cx } from "../../../components/kit";
import { CameraCard } from "./CameraCard";
import { AssistButton } from "./AssistButton";
import { MoveModeMenu } from "./MoveMode";
import { promptDialog } from "../dialog";
import { openDraft, quickDraft } from "./Modals";

const LABEL_ICON: Record<ItemLabel, React.ReactNode> = {
  object: <Box size={11} />,
  character: <User size={11} />,
  text: <Type size={11} />,
};

// ---------------- 空画布：AI 起稿入口 ----------------
function EmptyBoard({ caption }: { caption: string }) {
  const [text, setText] = useState("");
  const streaming = useStore((st) => st.streaming);
  const go = () => {
    const t = text.trim() || caption.trim();
    if (!t) return openDraft();
    if (quickDraft(t)) setText("");
  };
  return (
    <div className="board-empty">
      <div className="draft-card" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
        <div className="draft-card-title"><Sparkles size={14} />用一句话起稿</div>
        <div className="draft-card-row">
          <textarea className="textarea" rows={2} value={text} placeholder={caption.trim() ? `留空 = 用整体描述：${caption.trim().slice(0, 40)}` : "例如：雨夜街头，穿风衣的女侦探站在左侧回头看，右后方是霓虹招牌"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go(); } }} />
          <button type="button" className="btn btn-primary btn-icon draft-go" onClick={go} disabled={!text.trim() && !caption.trim()} title="生成定位框和提示词（Enter）">
            {streaming ? <Loader2 size={15} className="spin" /> : <ArrowUp size={15} />}
          </button>
        </div>
        <div className="draft-card-foot">
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => openDraft(text)}>更多选项…</button>
          <span className="spacer" />
          <span><SquareDashed size={12} /> 或按 <kbd>B</kbd> 手动拖拽画框</span>
        </div>
      </div>
    </div>
  );
}

// ---------------- 工具条 ----------------
function Toolbar({ zoom, setZoom }: { zoom: number; setZoom: (z: number) => void }) {
  const s = useWorkState();
  const L = s.doc!.layout;
  const cam = L.camera;
  return (
    <div className="stage-bar">
      <Seg
        value={s.tool}
        onChange={(v) => setUi({ tool: v })}
        options={[
          { v: "select", t: <><MousePointer2 size={13} /><span className="bar-lbl">选择</span></>, title: "选择 / 移动（V）" },
          { v: "draw", t: <><SquareDashed size={13} /><span className="bar-lbl">画框</span></>, title: "拖拽画新框（B）" },
        ]}
      />
      <Seg
        small
        value={s.drawLabel}
        onChange={(v) => setUi({ drawLabel: v, tool: "draw" })}
        options={(["object", "character", "text"] as ItemLabel[]).map((l) => ({ v: l, t: <>{LABEL_ICON[l]}<span className="bar-lbl">{LABEL_TEXT[l]}</span></>, title: `新框类型：${LABEL_TEXT[l]}` }))}
      />
      <div className="bar-sep" />
      <button type="button" className={cx("btn btn-sm", cam?.enabled && "on")} onClick={() => setUi({ cameraPanelOpen: true })} title="摄像机面板">
        <CameraIcon size={14} /><span className="bar-lbl">摄像机</span>{cam?.enabled && <span className="badge warm">开</span>}
      </button>
      <button type="button" className={cx("btn btn-sm btn-icon", s.showWire && "on")} disabled={!cam?.enabled} onClick={() => setUi({ showWire: !s.showWire })} title="显示 3D 体块线框">
        <Move3d size={14} />
      </button>
      <button type="button" className={cx("btn btn-sm", s.freeCam && "on")} disabled={!cam?.enabled} onClick={() => setUi({ freeCam: !s.freeCam })} title="自由镜头：在画布上拖拽转动机位（Shift+`，Esc 退出）">
        <Hand size={14} /><span className="bar-lbl">自由镜头</span>
      </button>
      <button type="button" className="btn btn-sm btn-warm" onClick={openDirector} title="全屏镜头调度：画框外的内容也看得到，支持自动取景、跟随主体、俯视图（F）">
        <Clapperboard size={14} /><span className="bar-lbl2">镜头调度</span>
      </button>
      <button type="button" className="btn btn-sm btn-agent" onClick={() => openDraft()} title="AI 起稿：用一段文字描述画面，自动生成定位框、每个框的描述、机位和灯光">
        <Sparkles size={14} /><span className="bar-lbl2">AI 起稿</span>
      </button>
      <div className="spacer" />
      <div className="bar-right">
      <div className="zoom-group">
        <button type="button" className="btn btn-ghost btn-xs btn-icon" onClick={() => setZoom(Math.max(0.25, zoom / 1.25))} title="缩小"><Minus size={13} /></button>
        <button type="button" className="btn btn-ghost btn-xs zoom-val num" onClick={() => setZoom(1)} title="适应窗口">{zoom === 1 ? "适应" : `${Math.round(zoom * 100)}%`}</button>
        <button type="button" className="btn btn-ghost btn-xs btn-icon" onClick={() => setZoom(Math.min(4, zoom * 1.25))} title="放大"><Plus size={13} /></button>
      </div>
      <AssistButton />
      <button type="button" className="btn btn-sm btn-primary" onClick={() => void compileNow(true)} title="编译成 MOSS 提示词（Ctrl+Enter）">
        {s.compiling ? <Loader2 size={14} className="spin" /> : <Play size={13} />}编译
      </button>
      </div>
    </div>
  );
}

// ---------------- 画布 ----------------
type Drag =
  | { kind: "move"; ids: string[]; start: Record<string, BBox>; x: number; y: number; moved: boolean;
      /** 镜头视图里拖：按投影反推原框和远近；grab 是鼠标抓住的框，ids 这组一起做刚体平移 */
      view?: { base: LayoutDraft; grab: string } }
  | { kind: "resize"; id: string; start: BBox; handle: string; x: number; y: number }
  | { kind: "draw"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "marquee"; x0: number; y0: number; x1: number; y1: number; add: boolean }
  | { kind: "orbit"; x: number; y: number; cam: Record<string, number>; pan: boolean };

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
// 与 .tray-inner 的 padding、画布下方尺寸标注对齐。少算任何一块，适配时内容会高出 1px，滚动条来回出现，整块画布就抖。
const TRAY_PAD_X = 72;
const TRAY_PAD_Y = 88;
const TRAY_CAPTION_H = 32;
const TRAY_SAFETY = 4;

/** 把地平线裁在画布矩形内。原来向两端延伸 40 倍，线会冲出滚动区域，把工作台撑出滚动条。 */
function horizonSegment(
  a: { x: number; y: number },
  b: { x: number; y: number },
  W: number,
  H: number,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx * dx + dy * dy < 1e-6) return null;
  const ts: number[] = [];
  const hit = (t: number) => {
    const x = a.x + t * dx;
    const y = a.y + t * dy;
    if (x >= -0.5 && x <= W + 0.5 && y >= -0.5 && y <= H + 0.5) ts.push(t);
  };
  if (dx !== 0) {
    hit(-a.x / dx);
    hit((W - a.x) / dx);
  }
  if (dy !== 0) {
    hit(-a.y / dy);
    hit((H - a.y) / dy);
  }
  if (ts.length < 2) return null;
  ts.sort((p, q) => p - q);
  const t0 = ts[0];
  const t1 = ts[ts.length - 1];
  return { x1: a.x + t0 * dx, y1: a.y + t0 * dy, x2: a.x + t1 * dx, y2: a.y + t1 * dy };
}

function snapMove(b: BBox, others: BBox[], W: number, H: number, tol: number): { dx: number; dy: number; gx: number[]; gy: number[] } {
  const xs = [0, W / 2, W, ...others.flatMap((o) => [o[0], o[2], (o[0] + o[2]) / 2])];
  const ys = [0, H / 2, H, ...others.flatMap((o) => [o[1], o[3], (o[1] + o[3]) / 2])];
  const bx = [b[0], (b[0] + b[2]) / 2, b[2]];
  const by = [b[1], (b[1] + b[3]) / 2, b[3]];
  let dx = 0, dy = 0, bestX = tol + 1, bestY = tol + 1;
  const gx: number[] = [], gy: number[] = [];
  for (const x of xs) for (const v of bx) if (Math.abs(x - v) < bestX) { bestX = Math.abs(x - v); dx = x - v; }
  for (const y of ys) for (const v of by) if (Math.abs(y - v) < bestY) { bestY = Math.abs(y - v); dy = y - v; }
  if (bestX > tol) dx = 0; else gx.push(...xs.filter((x) => bx.some((v) => Math.abs(x - (v + dx)) < 0.5)));
  if (bestY > tol) dy = 0; else gy.push(...ys.filter((y) => by.some((v) => Math.abs(y - (v + dy)) < 0.5)));
  return { dx, dy, gx, gy };
}

function CanvasView({ zoom, setZoom }: { zoom: number; setZoom: (z: number) => void }) {
  const s = useWorkState();
  const doc = s.doc!;
  const L = doc.layout;
  const W = L.width, H = L.height;
  const tray = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [guides, setGuides] = useState<{ gx: number[]; gy: number[] }>({ gx: [], gy: [] });
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  // 量外层（不滚动的）容器：它的尺寸不受内部滚动条出现/消失影响，适配尺寸就不会和滚动条互相触发。
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      setSize((prev) => (Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1 ? prev : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = Math.min(
    Math.max(48, size.w - TRAY_PAD_X - TRAY_SAFETY) / W,
    Math.max(48, size.h - TRAY_PAD_Y - TRAY_CAPTION_H - TRAY_SAFETY) / H,
  );
  const scale = Math.max(0.05, fit * zoom);
  const cam = L.camera;
  const camOn = !!cam?.enabled;
  const moved = cameraMoved(L);
  const proj: Projection | null = useMemo(() => (camOn ? projectLayout(L) : null), [L, camOn]);
  const pending = pendingProposalFor(s, s.pageId);
  const changes = useMemo(() => (pending ? diffDocs(normalizeDoc(pending.proposal.base), normalizeDoc(pending.proposal.proposed)) : []), [pending]);
  const proposedLayout = pending ? normalizeDoc(pending.proposal.proposed).layout : null;
  const sel = new Set(s.selection);

  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const r = board.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  // 自由镜头：拖拽转机位
  const startOrbit = (e: React.PointerEvent) => {
    if (!cam) return;
    setDrag({ kind: "orbit", x: e.clientX, y: e.clientY, cam: { ...cam } as any, pan: e.shiftKey || e.button === 1 || e.button === 2 });
  };

  const onBoxDown = (e: React.PointerEvent, it: LayoutItem) => {
    if (e.button !== 0) return;
    // 画框工具：在已有的框上也能直接拖出新框（事件交给画布处理）
    if (s.tool === "draw" && !s.freeCam) return;
    e.stopPropagation();
    if (s.freeCam) return startOrbit(e);
    // 点一个框 = 选中整组；Alt 只选它自己（组内微调）
    const solo = e.altKey;
    const unit = withGroup([it.id], solo);
    const ids = e.shiftKey || e.ctrlKey || e.metaKey
      ? sel.has(it.id) ? s.selection.filter((x) => !unit.includes(x)) : [...s.selection, ...unit.filter((x) => !sel.has(x))]
      : sel.has(it.id) && !solo ? s.selection : unit;
    select(ids);
    if (it.locked || s.tool === "draw" || !ids.includes(it.id)) return;
    // 拖动带上同组的框；镜头视图里还按「自由 / 冻结」决定带上哪些
    const t = moveTargets(L, ids, moved ? s.moveScope : "free", it.id, solo);
    if (!t.ids.length) {
      if (t.pinned) toast("组里有锁定的框，整组不能移动（按住 Alt 拖动可以单独移动没锁定的框）");
      return;
    }
    const start: Record<string, BBox> = {};
    for (const x of L.items) if (t.ids.includes(x.id)) start[x.id] = [...x.bbox] as BBox;
    const p = toCanvas(e);
    setDrag({ kind: "move", ids: t.ids, start, x: p.x, y: p.y, moved: false, view: moved ? { base: L, grab: it.id } : undefined });
  };

  const onHandleDown = (e: React.PointerEvent, it: LayoutItem, h: string) => {
    e.stopPropagation();
    const p = toCanvas(e);
    setDrag({ kind: "resize", id: it.id, start: [...it.bbox] as BBox, handle: h, x: p.x, y: p.y });
  };

  const onEmptyDown = (e: React.PointerEvent) => {
    if (s.freeCam || (e.button === 1 && camOn)) return startOrbit(e);
    if (e.button !== 0) return;
    const p = toCanvas(e);
    if (s.tool === "draw") setDrag({ kind: "draw", x0: Math.max(0, Math.min(W, p.x)), y0: Math.max(0, Math.min(H, p.y)), x1: p.x, y1: p.y });
    else setDrag({ kind: "marquee", x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: e.shiftKey });
  };

  useEffect(() => {
    if (!drag) return;
    const key = `drag${Date.now()}`;
    const mv = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === "orbit") {
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (d.pan) setCamera({ pan_x: d.cam.pan_x - dx * 0.0025, pan_y: d.cam.pan_y - dy * 0.0025 }, key);
        else setCamera({ orbit: d.cam.orbit - dx * 0.35, pitch: d.cam.pitch + dy * 0.3 }, key);
        return;
      }
      const p = toCanvas(e);
      if (d.kind === "move") {
        let dx = p.x - d.x, dy = p.y - d.y;
        if (!d.moved && Math.hypot(dx, dy) * scale < 3) return;
        if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
        if (d.view) {
          // 镜头视图：抓住的框跟着鼠标在画面里走，同组（或冻结时全部）体块做同样的世界平移；原框和远近由投影反推（不吸附、允许拖出画）
          if (!d.moved) setDrag({ ...d, moved: true });
          applyMove(dragInView(d.view.base, d.view.grab, d.ids, dx, dy, useStore.getState().moveHold), key);
          return;
        }
        const ids = d.ids;
        const all = Object.values(d.start);
        const ub: BBox = [Math.min(...all.map((b) => b[0])) + dx, Math.min(...all.map((b) => b[1])) + dy, Math.max(...all.map((b) => b[2])) + dx, Math.max(...all.map((b) => b[3])) + dy];
        // 不出画
        const cx1 = Math.max(0, -ub[0]) - Math.max(0, ub[2] - W);
        const cy1 = Math.max(0, -ub[1]) - Math.max(0, ub[3] - H);
        dx += cx1; dy += cy1;
        const others = L.items.filter((x) => !ids.includes(x.id) && !x.hidden).map((x) => x.bbox);
        const snapped = e.altKey ? { dx: 0, dy: 0, gx: [], gy: [] } : snapMove([ub[0] + cx1, ub[1] + cy1, ub[2] + cx1, ub[3] + cy1], others, W, H, 6 / scale);
        dx += snapped.dx; dy += snapped.dy;
        setGuides({ gx: snapped.gx, gy: snapped.gy });
        const patches: Record<string, Partial<LayoutItem>> = {};
        for (const id of ids) {
          const b = d.start[id];
          patches[id] = { bbox: [Math.round(b[0] + dx), Math.round(b[1] + dy), Math.round(b[2] + dx), Math.round(b[3] + dy)] as BBox };
        }
        if (!d.moved) setDrag({ ...d, moved: true });
        updateItems(patches, key);
      } else if (d.kind === "resize") {
        let [x1, y1, x2, y2] = d.start;
        const dx = p.x - d.x, dy = p.y - d.y;
        const h = d.handle;
        if (h.includes("w")) x1 += dx;
        if (h.includes("e")) x2 += dx;
        if (h.includes("n")) y1 += dy;
        if (h.includes("s")) y2 += dy;
        if (e.shiftKey && h.length === 2) {
          const ar = (d.start[2] - d.start[0]) / (d.start[3] - d.start[1]);
          const w = x2 - x1, hh = y2 - y1;
          if (Math.abs(w / ar) > Math.abs(hh)) { const nh = w / ar; if (h.includes("n")) y1 = y2 - nh; else y2 = y1 + nh; }
          else { const nw = hh * ar; if (h.includes("w")) x1 = x2 - nw; else x2 = x1 + nw; }
        }
        updateItems({ [d.id]: { bbox: clampBBox([x1, y1, x2, y2], W, H, 8) } }, key);
      } else {
        setDrag({ ...d, x1: Math.max(0, Math.min(W, p.x)), y1: Math.max(0, Math.min(H, p.y)) });
      }
    };
    const up = () => {
      const d = dragRef.current;
      setGuides({ gx: [], gy: [] });
      if (d?.kind === "draw") {
        const b = clampBBox([d.x0, d.y0, d.x1, d.y1], W, H, 8);
        if ((b[2] - b[0]) * scale > 6 && (b[3] - b[1]) * scale > 6) {
          // 镜头视图：按当前机位反推原框和远近，画出来的就是在画面里看到的
          if (moved) addItemInView(b, { x: d.x0, y: d.y0 });
          else addItem(b);
        } else select([]);
      } else if (d?.kind === "marquee") {
        const x1 = Math.min(d.x0, d.x1), x2 = Math.max(d.x0, d.x1), y1 = Math.min(d.y0, d.y1), y2 = Math.max(d.y0, d.y1);
        if ((x2 - x1) * scale < 4 && (y2 - y1) * scale < 4) select(d.add ? s.selection : []);
        else {
          const hit = L.items.filter((it) => {
            const b = moved && proj ? proj.items[it.id].raw : it.bbox;
            return b[0] < x2 && b[2] > x1 && b[1] < y2 && b[3] > y1;
          }).map((it) => it.id);
          select(withGroup(d.add ? Array.from(new Set([...s.selection, ...hit])) : hit));
        }
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.kind, scale, W, H, moved]);

  // 原生 wheel 监听（passive: false）：React 的 onWheel 是被动的，preventDefault 无效，
  // Ctrl+滚轮会把整个 WebView 一起缩放。
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(Math.max(0.25, Math.min(4, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
    } else if (s.freeCam && cam) {
      e.preventDefault();
      if (e.altKey) setCamera({ fov: cam.fov + (e.deltaY > 0 ? 2 : -2) }, "wheel-fov");
      else setCamera({ distance: cam.distance * (e.deltaY > 0 ? 1.06 : 1 / 1.06) }, "wheel-dist");
    }
  };
  useEffect(() => {
    const el = tray.current;
    if (!el) return;
    const fn = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", fn, { passive: false });
    return () => el.removeEventListener("wheel", fn);
  }, []);

  const bw = Math.floor(W * scale), bh = Math.floor(H * scale);
  const groupNo = groupNumbers(L.items);
  const shown = (it: LayoutItem): BBox => {
    const pr = proj?.items[it.id];
    return moved && pr ? (pr.visible ? pr.bbox : pr.raw) : it.bbox;
  };
  // 选中的组：画一个虚线外框
  const groupBoxes = [...groupNo.keys()].filter((g) => L.items.some((it) => it.group === g && sel.has(it.id))).map((g) => {
    const bs = L.items.filter((it) => it.group === g && !it.hidden).map(shown);
    if (!bs.length) return null;
    const pad = 5 / scale;
    return { g, n: groupNo.get(g)!, b: [Math.min(...bs.map((b) => b[0])) - pad, Math.min(...bs.map((b) => b[1])) - pad, Math.max(...bs.map((b) => b[2])) + pad, Math.max(...bs.map((b) => b[3])) + pad] as BBox };
  }).filter(Boolean) as { g: string; n: number; b: BBox }[];
  const offCount = moved && proj ? L.items.filter((it) => !it.hidden && proj.items[it.id]?.anchor === "world" && !proj.items[it.id].visible).length : 0;
  const boxes = L.items.map((it, i) => {
    const pr = proj?.items[it.id];
    const b = moved && pr ? (pr.visible ? pr.bbox : pr.raw) : it.bbox;
    const color = boxColor(it, i);
    const isSel = sel.has(it.id);
    const off = moved && pr && !pr.visible;
    const style: React.CSSProperties = {
      left: b[0] * scale, top: b[1] * scale, width: Math.max(2, (b[2] - b[0]) * scale), height: Math.max(2, (b[3] - b[1]) * scale),
      ["--c" as any]: color,
      zIndex: moved && proj ? 10 + proj.order.indexOf(it.id) : 10 + i,
    };
    return (
      <div
        key={it.id}
        className={cx("box", isSel && "sel", it.hidden && "is-hidden", it.locked && "is-locked", off && "is-off", moved && "is-proj", s.tool === "draw" && "drawing")}
        style={style}
        onPointerDown={(e) => onBoxDown(e, it)}
        onDoubleClick={() => it.group && select([it.id])}
        title={`${LABEL_TEXT[it.label]} · ${itemName(it, i)}${it.caption ? "\n" + it.caption.slice(0, 140) : ""}`}
      >
        <div className="box-tag">
          {LABEL_ICON[it.label]}
          <span className="ellipsis">{itemName(it, i)}</span>
          {it.group && <span className="box-tag-grp" title={`组 ${groupNo.get(it.group)}：移动、转镜头时整组一起动（双击只选这一个，Alt+拖动单独微调）`}><Link2 size={10} />{groupNo.get(it.group)}</span>}
          {off && <span className="box-tag-off">出画</span>}
        </div>
        {it.label === "text" && it.text && <div className="box-text">{it.text}</div>}
        {isSel && !moved && !it.locked && s.selection.length === 1 && HANDLES.map((h) => (
          <div key={h} className={`handle h-${h}`} onPointerDown={(e) => onHandleDown(e, it, h)} />
        ))}
      </div>
    );
  });

  // 线框 / 地平线 / 提案虚影
  const svg = (
    <svg className="board-svg" width={bw} height={bh} viewBox={`0 0 ${W} ${H}`}>
      {camOn && proj?.horizon && (() => {
        const seg = horizonSegment(proj.horizon.a, proj.horizon.b, W, H);
        if (!seg) return null;
        return (
          <g className="horizon">
            <line x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2} vectorEffect="non-scaling-stroke" />
          </g>
        );
      })()}
      {camOn && s.showWire && proj && L.items.map((it, i) => {
        const pr = proj.items[it.id];
        if (!pr.corners || it.hidden) return null;
        const c = pr.corners;
        const color = boxColor(it, i);
        const seg = (a: number, b: number, back: boolean) => {
          const p = c[a], q = c[b];
          if (!p || !q) return null;
          return <line key={`${a}-${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={color} strokeOpacity={back ? 0.4 : 0.85}
            strokeDasharray={back ? "4 3" : undefined} strokeWidth={sel.has(it.id) ? 1.6 : 1} vectorEffect="non-scaling-stroke" />;
        };
        return (
          <g key={it.id}>
            {[[4, 5], [5, 6], [6, 7], [7, 4]].map(([a, b]) => seg(a, b, true))}
            {[[0, 4], [1, 5], [2, 6], [3, 7]].map(([a, b]) => seg(a, b, true))}
            {[[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b]) => seg(a, b, false))}
          </g>
        );
      })}
      {camOn && proj?.vp && moved && (
        <g className="vp" transform={`translate(${proj.vp.x} ${proj.vp.y})`}>
          <circle r={5 / scale} vectorEffect="non-scaling-stroke" />
          <line x1={-9 / scale} x2={9 / scale} vectorEffect="non-scaling-stroke" />
          <line y1={-9 / scale} y2={9 / scale} vectorEffect="non-scaling-stroke" />
        </g>
      )}
      {groupBoxes.map(({ g, b }) => (
        <rect key={g} className="group-outline" x={b[0]} y={b[1]} width={b[2] - b[0]} height={b[3] - b[1]} rx={6 / scale} vectorEffect="non-scaling-stroke" />
      ))}
      {guides.gx.map((x, i) => <line key={`gx${i}`} className="snap" x1={x} x2={x} y1={0} y2={H} vectorEffect="non-scaling-stroke" />)}
      {guides.gy.map((y, i) => <line key={`gy${i}`} className="snap" y1={y} y2={y} x1={0} x2={W} vectorEffect="non-scaling-stroke" />)}
      {pending && !moved && proposedLayout && changes.map((ch) => {
        if (!ch.itemId) return null;
        const it = (ch.kind === "remove" ? L.items : proposedLayout.items).find((x) => x.id === ch.itemId);
        if (!it) return null;
        if (ch.kind === "update" && !ch.fields?.includes("bbox")) return null;
        const b = it.bbox;
        return (
          <g key={ch.key} className={cx("ghost", ch.kind)}>
            <rect x={b[0]} y={b[1]} width={b[2] - b[0]} height={b[3] - b[1]} vectorEffect="non-scaling-stroke" rx={4 / scale} />
            {ch.kind === "remove" && <path d={`M${b[0]} ${b[1]}L${b[2]} ${b[3]}M${b[2]} ${b[1]}L${b[0]} ${b[3]}`} vectorEffect="non-scaling-stroke" />}
          </g>
        );
      })}
      {drag && (drag.kind === "draw" || drag.kind === "marquee") && (
        <rect className={drag.kind === "draw" ? "draw-rect" : "marquee"} x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)}
          width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );

  return (
    <div ref={wrap} className="tray-wrap">
    <div
      ref={tray}
      className={cx("tray", s.freeCam && "freecam", s.tool === "draw" && "tool-draw", drag?.kind === "orbit" && "orbiting")}
      onPointerDown={onEmptyDown}
      onContextMenu={(e) => s.freeCam && e.preventDefault()}
    >
      {/* 只在比可见区大时才撑开；否则由 min-width/min-height:100% 填满滚动区，不会多出 1px */}
      <div className="tray-inner" style={{ width: bw + TRAY_PAD_X, height: bh + TRAY_PAD_Y + TRAY_CAPTION_H }}>
        <div ref={board} className={cx("artboard", moved && "cam-view")} style={{ width: bw, height: bh }}>
          <div className="artboard-grid" />
          {svg}
          {boxes}
          {!L.items.length && (
            <EmptyBoard caption={L.summary.caption} />
          )}
        </div>
        <div className="board-caption num" style={{ width: bw }}>
          <span>{W} × {H}</span>
          {camOn && (
            <span className="cap-right">
              <span className="warm-text ellipsis" title={moved ? "拖动框时按透视换算回原框位置和远近；要改大小，先点「定为基准」" : "摄像机在初始机位，框就是原框"}>
                <CameraIcon size={11} />{moved ? "镜头视图 · 框可直接拖动" : "初始机位"}
              </span>
              {moved && offCount > 0 && (
                <button type="button" className="btn btn-xs btn-warm" onPointerDown={(e) => e.stopPropagation()} onClick={() => bringAllIntoFrame()}
                  title="镜头不动，把完全出画的 3D 体块（连同同组的框）挪回画面里">
                  <Magnet size={11} />拉回 {offCount}
                </button>
              )}
              {moved && <MoveModeMenu small align="right" />}
            </span>
          )}
        </div>
      </div>
    </div>
      {s.freeCam && (
        <div className="freecam-hud">
          <Hand size={13} /> 自由镜头 · 拖拽 环绕/俯仰 · Shift+拖拽 平移 · 滚轮 推拉 · Alt+滚轮 视角 · <kbd>Esc</kbd> 退出
        </div>
      )}
      {pending && (
        <div className="proposal-banner" onPointerDown={(e) => e.stopPropagation()}>
          <span className="badge warm">{changes.length}</span>
          <span>Agent 提议的改动{moved ? "" : "（虚线为新位置）"}</span>
          <button type="button" className="btn btn-xs btn-primary" onClick={() => void resolveProposal(pending.messageId, s.pageId, "accepted")}><Check size={12} />采纳全部</button>
          <button type="button" className="btn btn-xs" onClick={() => void resolveProposal(pending.messageId, s.pageId, "rejected")}><X size={12} />拒绝</button>
        </div>
      )}
      <CameraCard />
    </div>
  );
}

// ---------------- Caption 编辑 ----------------
function CaptionEditor() {
  const s = useWorkState();
  const doc = s.doc!;
  const text = doc.caption.caption;
  const words = text.trim() ? (text.match(/[A-Za-z0-9'-]+|[\u3400-\u9fff]/g) || []).length : 0;
  return (
    <div className="tray caption-tray">
      <div className="caption-paper">
        <div className="caption-head">
          <span className="section-title">Caption 散文</span>
          <span className="spacer" />
          <span className="muted num">{words} 词 · {text.length} 字符</span>
        </div>
        <textarea
          className="caption-text"
          value={text}
          placeholder="写一段完整、连贯的画面描述：主体、动作、场景、光线、镜头、画风……也可以在右侧让 Agent 起稿。"
          onChange={(e) => commit({ ...doc, caption: { caption: e.target.value } }, "caption-text")}
        />
      </div>
    </div>
  );
}

// ---------------- 编译结果抽屉 ----------------
function CompileDrawer() {
  const s = useWorkState();
  const [withExtra, setWithExtra] = useState(false);
  const [auto, setAuto] = useState(autoCompileOn);
  if (!s.compileOpen) return null;
  const r = s.compileResult;
  const full = r ? (withExtra && r.prefix ? r.prefix.trim().replace(/[,，]?$/, ", ") : "") + r.prompt : "";
  const copy = async (t: string) => {
    try {
      await navigator.clipboard.writeText(t);
      toast("已复制", "ok");
    } catch {
      toast("复制失败：请手动选择文本", "err");
    }
  };
  const archive = async () => {
    const title = await promptDialog("存入档案库", useStore.getState().series.flatMap((x) => x.pages).find((p) => p.id === s.pageId)?.name || "未命名", "保存整页文档和编译结果，之后可在档案库复用。");
    if (!title) return;
    await api.addArchive({ title, category: "", doc: s.doc!, prompt: r?.prompt || "" });
    toast("已存入档案库", "ok");
  };
  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="section-title">编译结果</span>
        {s.compileStale && r && (s.compiling || auto ? <span className="chip" title="文档有改动，正在自动重新编译"><Loader2 size={10} className="spin" />更新中</span>
          : <span className="chip warm" title="文档在编译之后有改动">已过期</span>)}
        {r?.checks?.length ? <span className="chip warm"><AlertTriangle size={11} />{r.checks.length} 个提醒</span> : null}
        <div className="spacer" />
        <label className="row hint" title="抽屉开着时，改动后自动重新编译">
          <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); setAutoCompile(e.target.checked); }} />自动
        </label>
        <label className="row hint" title="复制时在最前面加上设置里的质量前缀">
          <input type="checkbox" checked={withExtra} onChange={(e) => setWithExtra(e.target.checked)} />含前缀
        </label>
        <button type="button" className="btn btn-xs" onClick={() => void compileNow(true)}><RefreshCw size={11} />重新编译</button>
        <button type="button" className="btn btn-xs" disabled={!r} onClick={() => void copy(full)}><ClipboardCopy size={11} />复制</button>
        <button type="button" className="btn btn-xs" disabled={!r?.negative} onClick={() => void copy(r!.negative)} title={r?.negative}>复制负面</button>
        <button type="button" className="btn btn-xs" onClick={() => void archive()}><Save size={11} />存档</button>
        <button type="button" className="btn btn-ghost btn-xs btn-icon" onClick={() => setUi({ compileOpen: false })} title="收起"><ChevronDown size={13} /></button>
      </div>
      <div className="drawer-body">
        {s.compileError ? (
          <div className="compile-error"><AlertTriangle size={14} />{s.compileError}</div>
        ) : r ? (
          <>
            {r.checks.length > 0 && (
              <div className="checks">{r.checks.map((c, i) => <span key={i} className="chip warm">{c}</span>)}</div>
            )}
            <pre className="prompt-out mono">{full}</pre>
          </>
        ) : (
          <div className="empty">{s.compiling ? "编译中…" : "点「编译」生成 MOSS 提示词"}</div>
        )}
      </div>
    </div>
  );
}

export function Stage() {
  const s = useWorkState();
  const director = s.director;
  const [zoom, setZoom] = useState(1);
  useEffect(() => setZoom(1), [s.pageId]);
  if (!s.doc) return <main className="stage" />;
  const layout = s.doc.kind === "layout";
  return (
    <main className="stage">
      {layout ? <Toolbar zoom={zoom} setZoom={setZoom} /> : (
        <div className="stage-bar">
          <span className="section-title">Caption 页</span>
          <span className="hint">整段散文提示词，适合不需要精确构图的画面</span>
          <div className="spacer" />
          <AssistButton />
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void compileNow(true)}><Play size={13} />编译</button>
        </div>
      )}
      {layout ? (director ? <div className="tray-wrap director-placeholder" /> : <CanvasView zoom={zoom} setZoom={setZoom} />) : <CaptionEditor />}
      <CompileDrawer />
    </main>
  );
}

export type { LayoutDraft };
