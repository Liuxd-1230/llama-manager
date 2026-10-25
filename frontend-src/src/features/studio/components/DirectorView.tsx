/**
 * 全屏镜头调度：画框居中，四周留出画外区域，出画的体块也能看见；
 * 自动取景 / 跟随主体 / 俯视图拖机位。所有机位修改都经过 applyCam。
 */
import {
  AlertTriangle, Anchor as AnchorIcon, Box, Camera as CameraIcon, CheckCircle2, ChevronDown, Clapperboard, Columns2, Crosshair, Eye, Grid3x3, Lightbulb,
  LocateFixed, Magnet, Maximize2, Minimize2, Move, Move3d, Redo2, Rotate3d, RotateCcw, ScanSearch, Square, Undo2, Wand2, X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { desktopApi } from "../api";
import {
  CAMERA_LIMITS, CAMERA_PRESETS, CUBE_FACES, autoFrame, bodyOf, cameraMoved, cameraPhraseZh, clampCamera, dragInView, dragOnPlan, equivFocal, faceNormal,
  framingZoom, measureItems, moveTargets, planView, projectLayout, sceneData, solveFraming, subjectItem, wrapDeg, type AutoFrameMode, type FrameGoal,
  type Projection,
} from "../lib/camera";
import { backdropShade, hexRgb, lightingSummaryZh, normalizeLighting, presetById, rgbHex, shade, worldLights, type RGB } from "../lib/lighting";
import { BodyPanel, LightingPanel } from "./DirectorPanels";
import { SceneView } from "./SceneView";
import { boxColor, defaultCamera, itemName } from "../lib/doc";
import {
  applyMove, bakeCamera, bringAllIntoFrame, bringIntoFrame, currentPage, nudgeInView, redo, select, setCamera, setUi, toast, undo, useStore, withGroup,
} from "../store";
import type { BBox, Camera, LayoutDraft } from "../types";
import { LABEL_TEXT } from "../types";
import { Dial, MenuItem, Popover, Seg, Switch, cx, useAnchor } from "../ui";
import { AssistButton } from "./AssistButton";
import { Gizmo, ROWS } from "./CameraCard";
import { MoveModeMenu } from "./MoveMode";

interface Prefs {
  thirds: boolean;
  safe: boolean;
  ghost: boolean;
  outside: boolean;
  keepSize: boolean;
  /** 拖拽画面时：转机位 / 移动体块 */
  tool: "camera" | "move";
  /** 主区：镜头画面 / 分屏 / 3D 场景 */
  layout: "shot" | "split" | "scene";
  /** 分屏时镜头画面占的比例 */
  split: number;
  /** 镜头画面里按灯光给体块着色 */
  shade: boolean;
  /** 右侧分页 */
  tab: "camera" | "light" | "body";
}
const PREF_KEY = "moss.director.prefs";
const loadPrefs = (): Prefs => {
  const d: Prefs = { thirds: true, safe: false, ghost: true, outside: true, keepSize: false, tool: "camera", layout: "split", split: 0.5, shade: true, tab: "camera" };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") };
  } catch {
    return d;
  }
};

interface Follow {
  ids: string[];
  goal: FrameGoal;
}

type Status = "in" | "partial" | "out" | "behind" | "fixed";
const STATUS_TEXT: Record<Status, string> = { in: "画内", partial: "部分出画", out: "出画", behind: "镜头后", fixed: "固定" };

function statusOf(pr: Projection["items"][string] | undefined): Status {
  if (!pr) return "out";
  if (pr.anchor !== "world") return "fixed";
  if (!pr.corners) return "behind";
  if (!pr.visible) return "out";
  return pr.partial ? "partial" : "in";
}

/** 把直线 a→b 裁到矩形内（两端延长） */
function clipLine(a: { x: number; y: number }, b: { x: number; y: number }, x0: number, y0: number, x1: number, y1: number) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx * dx + dy * dy < 1e-9) return null;
  const ts: number[] = [];
  const hit = (t: number) => {
    const x = a.x + t * dx, y = a.y + t * dy;
    if (x >= x0 - 0.5 && x <= x1 + 0.5 && y >= y0 - 0.5 && y <= y1 + 0.5) ts.push(t);
  };
  if (dx) { hit((x0 - a.x) / dx); hit((x1 - a.x) / dx); }
  if (dy) { hit((y0 - a.y) / dy); hit((y1 - a.y) / dy); }
  if (ts.length < 2) return null;
  ts.sort((p, q) => p - q);
  return { x1: a.x + ts[0] * dx, y1: a.y + ts[0] * dy, x2: a.x + ts[ts.length - 1] * dx, y2: a.y + ts[ts.length - 1] * dy };
}

const lim = (v: number) => Math.max(-1e5, Math.min(1e5, v));
const center = (b: BBox) => ({ x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 });
const sizeOf = (b: BBox) => Math.sqrt(Math.max(1, (b[2] - b[0]) * (b[3] - b[1])));

// ---------------- 俯视图 ----------------
function PlanMap({ L, cam, selection, onCam, moveMode, onMoved }: {
  L: LayoutDraft; cam: Camera; selection: string[]; onCam: (p: Partial<Camera>, key?: string) => void; moveMode: boolean; onMoved: () => void;
}) {
  const Wm = 328, Hm = 214, P = 16;
  const data = useMemo(() => planView(L, cam), [L, cam]);
  const frozen = useRef<[number, number, number, number] | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const live: [number, number, number, number] = (() => {
    const [x1, z1, x2, z2] = data.bounds;
    const zz2 = Math.max(z2, data.far);
    const padX = (x2 - x1) * 0.08 + data.unit * 0.05, padZ = (zz2 - z1) * 0.08 + data.unit * 0.05;
    return [x1 - padX, z1 - padZ, x2 + padX, zz2 + padZ];
  })();
  const bnd = frozen.current || live;
  const s = Math.min((Wm - 2 * P) / (bnd[2] - bnd[0]), (Hm - 2 * P) / (bnd[3] - bnd[1]));
  const offX = (Wm - (bnd[2] - bnd[0]) * s) / 2, offY = (Hm - (bnd[3] - bnd[1]) * s) / 2;
  const X = (x: number) => offX + (x - bnd[0]) * s;
  const Y = (z: number) => Hm - offY - (z - bnd[1]) * s;
  const inv = (px: number, py: number) => ({ x: bnd[0] + (px - offX) / s, z: bnd[1] + (Hm - offY - py) / s });
  const byId = new Map(L.items.map((it, i) => [it.id, { it, i }]));
  const c = data.cam;
  const reach = Math.max(Math.hypot(data.pivot.x - c.x, data.pivot.z - c.z) * 1.7, data.unit * 0.6);
  const wedge = [-1, 1].map((sgn) => {
    const a = Math.atan2(c.fx, c.fz) + sgn * c.half;
    return { x: c.x + Math.sin(a) * reach, z: c.z + Math.cos(a) * reach };
  });
  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return inv(((e.clientX - r.left) / r.width) * Wm, ((e.clientY - r.top) / r.height) * Hm);
  };
  const onDown = (e: React.PointerEvent, onIcon: boolean) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = ref.current!;
    el.setPointerCapture(e.pointerId);
    frozen.current = bnd;
    const key = `plan${Date.now()}`;
    const T = data.pivot;
    const cosP = Math.max(0.05, Math.cos((cam.pitch * Math.PI) / 180));
    const p0 = toLocal(e);
    let v0 = { x: p0.x - T.x, z: p0.z - T.z };
    let o0 = cam.orbit, d0 = cam.distance;
    if (!onIcon) {
      // 点空白处：机位直接放到这里
      o0 = wrapDeg((Math.atan2(v0.x, -v0.z) * 180) / Math.PI);
      d0 = Math.hypot(v0.x, v0.z) / (data.unit * cosP);
      onCam({ orbit: o0, distance: d0 }, key);
      d0 = clampCamera({ ...cam, distance: d0 }).distance;
    }
    if (Math.hypot(v0.x, v0.z) < 1e-6) v0 = { x: 0, z: -1 };
    const a0 = Math.atan2(v0.x, -v0.z), r0 = Math.hypot(v0.x, v0.z);
    const mv = (ev: PointerEvent) => {
      const p = toLocal(ev);
      const v = { x: p.x - T.x, z: p.z - T.z };
      const a = Math.atan2(v.x, -v.z);
      onCam({ orbit: wrapDeg(o0 + ((a - a0) * 180) / Math.PI), distance: d0 * (Math.hypot(v.x, v.z) / Math.max(1e-6, r0)) }, key);
    };
    const up = () => {
      frozen.current = null;
      el.removeEventListener("pointermove", mv);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      onCam({}, key);
    };
    el.addEventListener("pointermove", mv);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  /** 体块模式：在俯视图里拖体块（地面上平移），按当前的移动方式带上同组 / 全部 */
  const onItemDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const solo = e.altKey;
    const sel = useStore.getState().selection;
    const ids = sel.includes(id) && !solo ? sel : withGroup([id], solo);
    select(ids);
    if (!moveMode) return;
    e.preventDefault();
    const st = useStore.getState();
    const base = st.doc?.layout;
    if (!base) return;
    const t = moveTargets(base, ids, st.moveScope, id, solo);
    if (!t.ids.length) {
      if (t.pinned) toast("锁定的框（或组里有锁定的框）不能移动");
      return;
    }
    const el = ref.current!;
    el.setPointerCapture(e.pointerId);
    frozen.current = bnd;
    const key = `planmv${Date.now()}`;
    const p0 = toLocal(e);
    let movedAny = false;
    const mv = (ev: PointerEvent) => {
      const p = toLocal(ev);
      movedAny = true;
      applyMove(dragOnPlan(base, t.ids, p.x - p0.x, p.z - p0.z, useStore.getState().moveHold), key);
    };
    const up = () => {
      frozen.current = null;
      el.removeEventListener("pointermove", mv);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (movedAny) onMoved();
    };
    el.addEventListener("pointermove", mv);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const path = (pts: { x: number; z: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)} ${Y(p.z).toFixed(1)}`).join("") + "Z";
  return (
    <svg ref={ref} className={cx("plan-map", moveMode && "move-mode")} width={Wm} height={Hm} viewBox={`0 0 ${Wm} ${Hm}`} onPointerDown={(e) => onDown(e, false)}
      onWheel={(e) => onCam({ distance: cam.distance * (e.deltaY > 0 ? 1.06 : 1 / 1.06) }, "plan-wheel")}>
      <line x1={P} x2={Wm - P} y1={Y(data.far)} y2={Y(data.far)} className="pm-far" />
      <text x={Wm - P} y={Y(data.far) - 4} className="pm-note" textAnchor="end">远景 / 背景板</text>
      <path d={path([c, wedge[0], wedge[1]])} className="pm-wedge" />
      {data.items.map((pi) => {
        const e = byId.get(pi.id);
        if (!e) return null;
        const col = boxColor(e.it, e.i);
        const on = selection.includes(pi.id);
        return (
          <g key={pi.id} onPointerDown={(ev) => onItemDown(ev, pi.id)} className="pm-item">
            <path d={path(pi.poly)} fill={col} fillOpacity={on ? 0.32 : 0.16} stroke={col} strokeWidth={on ? 2 : 1.2} />
            <line x1={X(pi.front[0].x)} y1={Y(pi.front[0].z)} x2={X(pi.front[1].x)} y2={Y(pi.front[1].z)} stroke={col} strokeWidth={on ? 3 : 2.2} />
            {(on || Math.abs(X(pi.front[1].x) - X(pi.front[0].x)) > 34) && (
              <text x={X(pi.center.x)} y={Y(pi.center.z) + 3.5} className="pm-label">{itemName(e.it, e.i).slice(0, 6)}</text>
            )}
          </g>
        );
      })}
      <g className="pm-pivot" transform={`translate(${X(data.pivot.x)} ${Y(data.pivot.z)})`}>
        <line x1={-5} x2={5} /><line y1={-5} y2={5} />
      </g>
      <line x1={X(c.x)} y1={Y(c.z)} x2={X(data.pivot.x)} y2={Y(data.pivot.z)} className="pm-ray" />
      <g className="pm-base" transform={`translate(${X(0)} ${Y(0)})`}>
        <circle r={4} />
        <text y={14} textAnchor="middle" className="pm-note">初始</text>
      </g>
      <g className="pm-cam" transform={`translate(${X(c.x)} ${Y(c.z)})`} onPointerDown={(e) => onDown(e, true)}>
        <circle r={9} className="pm-cam-hit" />
        <circle r={6.5} />
        <line x1={0} y1={0} x2={c.fx * 13} y2={-c.fz * 13} />
      </g>
    </svg>
  );
}

// ---------------- 主视图 ----------------
export function DirectorView() {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const showWire = useStore((s) => s.showWire);
  const canUndo = useStore((s) => s.undo.length > 0);
  const canRedo = useStore((s) => s.redo.length > 0);
  const pageName = useStore((s) => currentPage(s)?.name || "");
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const setPrefs = (p: Partial<Prefs>) => setPrefsState((old) => {
    const n = { ...old, ...p };
    try { localStorage.setItem(PREF_KEY, JSON.stringify(n)); } catch { /* ignore */ }
    return n;
  });
  const [follow, setFollowState] = useState<Follow | null>(null);
  const followRef = useRef<Follow | null>(null);
  const setFollow = (f: Follow | null) => { followRef.current = f; setFollowState(f); };
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [hover, setHover] = useState<string | null>(null);
  const [activeLight, setActiveLight] = useState<string | null>(null);
  const [mainSize, setMainSize] = useState({ w: 1200, h: 800 });
  const mainRef = useRef<HTMLDivElement>(null);
  const pageId = useStore((s) => s.pageId);
  const [viewZoom, setViewZoom] = useState(1);
  const [vp, setVp] = useState({ w: 1000, h: 700 });
  const [fs, setFs] = useState(false);
  const view = useRef<HTMLDivElement>(null);
  const anim = useRef(0);
  const auto = useAnchor();
  const comp = useAnchor();
  const fol = useAnchor();
  const pre = useAnchor();

  const L = doc?.kind === "layout" ? doc.layout : null;
  const cam = clampCamera(L?.camera || defaultCamera());
  const proj = useMemo(() => (L ? projectLayout(L) : null), [L]);

  useEffect(() => {
    const el = view.current;
    const mel = mainRef.current;
    if (!el || !mel) return;
    const ro = new ResizeObserver((en) => {
      for (const e of en) {
        const w = Math.floor(e.contentRect.width), h = Math.floor(e.contentRect.height);
        if (e.target === el) { if (w > 0 && h > 0) setVp((p) => (p.w === w && p.h === h ? p : { w, h })); }
        else setMainSize((p) => (p.w === w && p.h === h ? p : { w, h }));
      }
    });
    ro.observe(el);
    ro.observe(mel);
    return () => ro.disconnect();
  }, []);

  // ---------- 机位修改（跟随主体时反解平移 / 距离） ----------
  const recapture = (c: Camera, ids?: string[]) => {
    const f = followRef.current;
    const lay = useStore.getState().doc?.layout;
    if (!f || !lay) return;
    const b = measureItems(lay, c, ids || f.ids);
    if (!b) return;
    const m = center(b);
    setFollow({ ids: ids || f.ids, goal: { cx: m.x, cy: m.y, size: sizeOf(b) } });
  };
  const solveFollow = (lay: LayoutDraft, next: Camera): Camera => {
    const f = followRef.current;
    if (!f) return next;
    return solveFraming(lay, next, f.ids, prefsRef.current.keepSize ? f.goal : { cx: f.goal.cx, cy: f.goal.cy },
      prefsRef.current.keepSize ? ["distance", "pan_x", "pan_y"] : ["pan_x", "pan_y"]);
  };
  const applyCam = useCallback((patch: Partial<Camera>, key = "director") => {
    cancelAnimationFrame(anim.current);
    const lay = useStore.getState().doc?.layout;
    if (!lay) return;
    if (!Object.keys(patch).length) return;
    let next = clampCamera({ ...(lay.camera || defaultCamera()), ...patch, enabled: true });
    const f = followRef.current;
    const manualFraming = "pan_x" in patch || "pan_y" in patch || ("distance" in patch && prefsRef.current.keepSize);
    if (f && !manualFraming) next = solveFollow(lay, next);
    setCamera(next, key);
    if (f && manualFraming) recapture(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 平滑过渡到目标机位（一步撤销） */
  const animateTo = (target: Camera, key = `anim${Date.now()}`) => {
    cancelAnimationFrame(anim.current);
    const lay = useStore.getState().doc?.layout;
    if (!lay) return;
    const from = clampCamera(lay.camera || defaultCamera());
    const to = clampCamera({ ...target, enabled: true });
    const t0 = performance.now();
    const dur = 260;
    const dOrbit = wrapDeg(to.orbit - from.orbit);
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      const k = 1 - Math.pow(1 - t, 3);
      const c: Camera = { ...to };
      c.orbit = wrapDeg(from.orbit + dOrbit * k);
      for (const kk of ["pitch", "roll", "fov", "pan_x", "pan_y", "pan_z"] as const) c[kk] = from[kk] + (to[kk] - from[kk]) * k;
      c.distance = Math.exp(Math.log(from.distance) + (Math.log(to.distance) - Math.log(from.distance)) * k);
      setCamera(t >= 1 ? to : c, key);
      if (t < 1) anim.current = requestAnimationFrame(step);
      else if (followRef.current) recapture(to);
    };
    anim.current = requestAnimationFrame(step);
  };

  const selWorld = L ? selection.filter((id) => { const it = L.items.find((x) => x.id === id); return it && !it.hidden && bodyOf(it, L).anchor === "world"; }) : [];
  const subj = L ? subjectItem(L) : null;
  const runAuto = (mode: AutoFrameMode, ids?: string[]) => {
    auto.close();
    if (!L) return;
    const target = ids || (mode === "subject" || mode === "center" ? (selWorld.length ? selWorld : undefined) : undefined);
    animateTo(autoFrame(L, cam, mode, target));
  };
  const frameItem = (id: string) => {
    if (!L) return;
    animateTo(solveFraming(L, cam, [id], { cx: L.width / 2, cy: L.height / 2, fit: { w: L.width * 0.7, h: L.height * 0.7 } }));
  };
  const toggleFollow = (on: boolean) => {
    if (!L) return;
    if (!on) return setFollow(null);
    const ids = selWorld.length ? selWorld : subj ? [subj.id] : [];
    if (!ids.length) return toast("没有可跟随的 3D 体块");
    const b = measureItems(L, cam, ids);
    const inside = b && center(b).x > 0 && center(b).x < L.width && center(b).y > 0 && center(b).y < L.height;
    if (b && inside) {
      setFollow({ ids, goal: { cx: center(b).x, cy: center(b).y, size: sizeOf(b) } });
    } else {
      const b0 = L.items.filter((it) => ids.includes(it.id)).map((it) => it.bbox);
      const u: BBox = [Math.min(...b0.map((x) => x[0])), Math.min(...b0.map((x) => x[1])), Math.max(...b0.map((x) => x[2])), Math.max(...b0.map((x) => x[3]))];
      const f = { ids, goal: { cx: center(u).x, cy: center(u).y, size: sizeOf(u) } };
      setFollow(f);
      animateTo(solveFraming(L, cam, ids, f.goal));
    }
  };

  const exit = () => {
    cancelAnimationFrame(anim.current);
    setUi({ director: false });
  };

  const toggleWindowFs = async () => {
    const d = desktopApi();
    try {
      if (d?.toggle_fullscreen) {
        await d.toggle_fullscreen();
        setFs((v) => !v);
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
        setFs(false);
      } else {
        await document.documentElement.requestFullscreen();
        setFs(true);
      }
    } catch {
      toast("无法切换全屏");
    }
  };

  // ---------- 键盘 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (!st.director || st.modal) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey) return;
      if (e.altKey && !(prefsRef.current.tool === "move" && e.key.startsWith("Arrow"))) return;
      const c = clampCamera(st.doc?.layout.camera || defaultCamera());
      const step = e.shiftKey ? 1 : 5;
      const k = e.key;
      if (k === "m" || k === "M") {
        e.preventDefault();
        const tool = prefsRef.current.tool === "move" ? "camera" : "move";
        setPrefs({ tool });
        toast(tool === "move" ? "体块模式：拖框移动体块，拖空白处仍可转机位（M 切换）" : "机位模式：拖拽转动机位（M 切换）");
        return;
      }
      if (prefsRef.current.tool === "move" && st.selection.length && k.startsWith("Arrow")) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        nudgeInView(k === "ArrowLeft" ? -d : k === "ArrowRight" ? d : 0, k === "ArrowUp" ? -d : k === "ArrowDown" ? d : 0, e.altKey);
        return;
      }
      if (k === "Escape") {
        if (document.querySelector(".menu")) return;
        e.preventDefault();
        exit();
      } else if (k === "ArrowLeft" || k === "ArrowRight") {
        e.preventDefault();
        applyCam({ orbit: wrapDeg(c.orbit + (k === "ArrowRight" ? step : -step)) }, "dir-key-orbit");
      } else if (k === "ArrowUp" || k === "ArrowDown") {
        e.preventDefault();
        applyCam({ pitch: c.pitch + (k === "ArrowUp" ? step : -step) }, "dir-key-pitch");
      } else if (k === "+" || k === "=") {
        applyCam({ distance: c.distance / 1.08 }, "dir-key-dist");
      } else if (k === "-" || k === "_") {
        applyCam({ distance: c.distance * 1.08 }, "dir-key-dist");
      } else if (k === "f" || k === "F") {
        exit();
      } else if (k === "a" || k === "A") {
        const lay = st.doc?.layout;
        if (lay) animateTo(autoFrame(lay, c, "smart"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 视口几何 ----------
  const HUD = 46;
  const W = L?.width || 1, H = L?.height || 1;
  const pad = Math.max(40, Math.min(150, Math.min(vp.w, vp.h) * 0.13));
  const fit = Math.min((vp.w - 2 * pad) / W, (vp.h - HUD - 2 * pad) / H);
  const scale = Math.max(0.02, fit * viewZoom);
  const bw = W * scale, bh = H * scale;
  const ox = Math.round((vp.w - bw) / 2), oy = Math.round((vp.h - HUD - bh) / 2);
  const toV = (x: number, y: number) => ({ x: ox + x * scale, y: oy + y * scale });

  // ---------- 交互：拖拽 / 点击 / 滚轮 ----------
  const drag = useRef<{
    x: number; y: number; cam: Camera; pan: boolean; moved: boolean; key: string; add: boolean;
    /** 体块模式下抓住了一个框：在画面里拖动它（ids 这组一起做刚体平移） */
    mv?: { grab: string; ids: string[]; base: LayoutDraft };
  } | null>(null);
  const [orbiting, setOrbiting] = useState<"" | "orbit" | "pan" | "move">("");
  const hitTest = (px: number, py: number): string | null => {
    if (!L || !proj) return null;
    const order = [...proj.order].reverse();
    for (const id of order) {
      const it = L.items.find((x) => x.id === id);
      const pr = proj.items[id];
      if (!it || it.hidden || !pr || pr.anchor === "backdrop") continue;
      if (pr.anchor === "world" && !pr.corners) continue;
      const a = toV(pr.raw[0], pr.raw[1]), b = toV(pr.raw[2], pr.raw[3]);
      if (px >= a.x && px <= b.x && py >= a.y && py <= b.y) return id;
    }
    return null;
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = view.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.button > 2) return;
    if ((e.target as HTMLElement).closest(".dir-hud, .dir-float")) return;
    e.preventDefault();
    view.current!.setPointerCapture(e.pointerId);
    const pan = e.shiftKey || e.button === 1 || e.button === 2;
    let mv: { grab: string; ids: string[]; base: LayoutDraft } | undefined;
    if (prefsRef.current.tool === "move" && !pan && L) {
      const p = local(e);
      const id = hitTest(p.x, p.y);
      if (id) {
        const solo = e.altKey;
        const sel = useStore.getState().selection;
        const unit = withGroup([id], solo);
        const ids = e.ctrlKey || e.metaKey
          ? sel.includes(id) ? sel.filter((x) => !unit.includes(x)) : [...sel, ...unit.filter((x) => !sel.includes(x))]
          : sel.includes(id) && !solo ? sel : unit;
        select(ids);
        const st = useStore.getState();
        const t = moveTargets(L, ids, st.moveScope, id, solo);
        if (t.ids.length && ids.includes(id)) mv = { grab: id, ids: t.ids, base: L };
        else if (t.pinned) toast("锁定的框（或组里有锁定的框）不能移动");
        if (!mv) { drag.current = null; return; }
      }
    }
    drag.current = { x: e.clientX, y: e.clientY, cam: { ...cam }, pan, moved: false, key: `dir${Date.now()}`, add: e.ctrlKey || e.metaKey, mv };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) {
      const p = local(e);
      const h = hitTest(p.x, p.y);
      if (h !== hover) setHover(h);
      return;
    }
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    if (!d.moved) { d.moved = true; setOrbiting(d.mv ? "move" : d.pan ? "pan" : "orbit"); }
    if (d.mv) {
      let mx = dx / scale, my = dy / scale;
      if (e.shiftKey) Math.abs(mx) > Math.abs(my) ? (my = 0) : (mx = 0);
      applyMove(dragInView(d.mv.base, d.mv.grab, d.mv.ids, mx, my, useStore.getState().moveHold), d.key);
    } else if (d.pan) {
      const f = H / 2 / Math.tan((d.cam.fov * Math.PI) / 360);
      const k = d.cam.distance / (scale * f);
      applyCam({ pan_x: d.cam.pan_x - dx * k, pan_y: d.cam.pan_y - dy * k }, d.key);
    } else {
      applyCam({ orbit: wrapDeg(d.cam.orbit - dx * 0.3), pitch: d.cam.pitch + dy * 0.25 }, d.key);
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setOrbiting("");
    if (d?.mv) {
      // 体块移动完：跟随目标的画面位置改成新的位置，免得下次转机位时被拉回去
      if (d.moved && followRef.current) recapture(clampCamera(useStore.getState().doc?.layout.camera || defaultCamera()));
      return;
    }
    if (!d || d.moved || e.button !== 0) return;
    const p = local(e);
    const id = hitTest(p.x, p.y);
    const sel = useStore.getState().selection;
    if (d.add && id) select(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
    else select(id ? [id] : []);
  };

  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    if ((e.target as HTMLElement).closest(".dir-hud, .dir-float")) return;
    e.preventDefault();
    const dv = e.deltaY || e.deltaX;
    if (!dv) return;
    const out = dv > 0;
    if (e.ctrlKey || e.metaKey) setViewZoom((z) => Math.max(0.3, Math.min(1.8, z * (out ? 1 / 1.1 : 1.1))));
    else if (e.altKey) applyCam({ fov: cam.fov + (out ? 2 : -2) }, "dir-wheel-fov");
    else if (e.shiftKey) applyCam({ roll: cam.roll + (out ? 1 : -1) }, "dir-wheel-roll");
    else applyCam({ distance: cam.distance * (out ? 1.06 : 1 / 1.06) }, "dir-wheel-dist");
  };
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const fn = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", fn, { passive: false });
    return () => el.removeEventListener("wheel", fn);
  }, []);

  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  if (!L || !proj) return null;

  // ---------- 统计 ----------
  const rows = L.items.map((it, i) => ({ it, i, pr: proj.items[it.id], st: it.hidden ? null : statusOf(proj.items[it.id]) }));
  const outCount = rows.filter((r) => r.st === "out" || r.st === "behind").length;
  const partCount = rows.filter((r) => r.st === "partial").length;
  const subjBox = subj ? measureItems(L, cam, [subj.id], proj) : null;
  const phrase = cameraPhraseZh(cam, L);
  const moved = cameraMoved(L);
  const followNames = follow ? follow.ids.map((id) => { const k = L.items.findIndex((x) => x.id === id); return k >= 0 ? itemName(L.items[k], k) : ""; }).filter(Boolean).join("、") : "";

  // ---------- 绘制 ----------
  const selSet = new Set(selection);
  const boxes: React.ReactNode[] = [];
  const labels: React.ReactNode[] = [];
  const clampR = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    l: Math.max(-400, a.x), t: Math.max(-400, a.y), r: Math.min(vp.w + 400, b.x), b: Math.min(vp.h + 400, b.y),
  });
  for (const id of proj.order) {
    const k = L.items.findIndex((x) => x.id === id);
    const it = L.items[k];
    const pr = proj.items[id];
    if (!it || it.hidden || !pr) continue;
    const st = statusOf(pr);
    if (st === "behind") continue;
    const a = toV(pr.raw[0], pr.raw[1]), b = toV(pr.raw[2], pr.raw[3]);
    const R = clampR(a, b);
    if (R.r <= R.l || R.b <= R.t) continue;
    const col = boxColor(it, k);
    const on = selSet.has(id);
    boxes.push(
      <div key={id} className={cx("dbox", on && "sel", hover === id && "hover", st === "out" && "out", pr.anchor !== "world" && "fixed")}
        style={{ left: R.l, top: R.t, width: R.r - R.l, height: R.b - R.t, ["--c" as any]: col }} />,
    );
    const lx = Math.max(4, Math.min(vp.w - 120, R.l)), ly = Math.max(20, Math.min(vp.h - HUD - 4, R.t));
    if (pr.anchor !== "backdrop" && b.x > 0 && a.x < vp.w && b.y > 0 && a.y < vp.h - HUD)
      labels.push(
        <div key={id} className={cx("dtag", on && "sel")} style={{ left: lx, top: ly, ["--c" as any]: col }}>
          <span className="ellipsis">{itemName(it, k)}</span>
          {(st === "out" || st === "partial") && <span className="dtag-st">{STATUS_TEXT[st]}</span>}
        </div>,
      );
  }

  const wires = showWire ? L.items.map((it, k) => {
    const pr = proj.items[it.id];
    if (!pr?.corners || it.hidden) return null;
    const c = pr.corners;
    const col = boxColor(it, k);
    const seg = (i: number, j: number, back: boolean) => {
      const p = c[i], q = c[j];
      if (!p || !q) return null;
      const A = toV(p.x, p.y), B = toV(q.x, q.y);
      return <line key={`${i}-${j}`} x1={lim(A.x)} y1={lim(A.y)} x2={lim(B.x)} y2={lim(B.y)} stroke={col}
        strokeOpacity={back ? 0.45 : 0.9} strokeDasharray={back ? "4 3" : undefined} strokeWidth={selSet.has(it.id) ? 1.8 : 1.1} />;
    };
    return (
      <g key={it.id}>
        {[[4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].map(([i, j]) => seg(i, j, true))}
        {[[0, 1], [1, 2], [2, 3], [3, 0]].map(([i, j]) => seg(i, j, false))}
      </g>
    );
  }) : null;

  // ---------- 光影预览：按灯光给体块的各个面着色 ----------
  const lgx = L.lighting ? normalizeLighting(L.lighting) : null;
  const shadeOn = prefs.shade && !!lgx?.enabled && lgx.lights.some((l) => l.enabled);
  let shadeLayer: React.ReactNode = null;
  if (shadeOn && lgx) {
    const sd = sceneData(L, cam);
    const wl = worldLights(lgx, cam);
    const C = sd.frame.C;
    const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const polys: React.ReactNode[] = [];
    const fa = toV(0, 0);
    const air = rgbHex(backdropShade([0.62, 0.6, 0.58], wl, lgx));
    for (const id of proj.order) {
      const k = L.items.findIndex((x) => x.id === id);
      const it = L.items[k];
      const pr = proj.items[id];
      const si = sd.items.find((x) => x.id === id);
      if (!it || it.hidden || !pr || !si) continue;
      const base = mix(hexRgb(boxColor(it, k)), [0.86, 0.84, 0.8], 0.42);
      if (pr.anchor === "backdrop") {
        const a = toV(pr.raw[0], pr.raw[1]), b = toV(pr.raw[2], pr.raw[3]);
        polys.push(<rect key={id} x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} fill={rgbHex(backdropShade(mix(base, [0.7, 0.7, 0.7], 0.3), wl, lgx))} fillOpacity={0.75} />);
        continue;
      }
      if (pr.anchor !== "world" || !pr.corners) continue;
      const flat = Math.hypot(si.pts[0][0] - si.pts[4][0], si.pts[0][1] - si.pts[4][1], si.pts[0][2] - si.pts[4][2]) < 1e-6;
      const fs: { d: string; fill: string; depth: number }[] = [];
      for (const f of flat ? [CUBE_FACES[0]] : CUBE_FACES) {
        const pts = f.map((i) => si.pts[i]);
        const fc = [0, 1, 2].map((j) => pts.reduce((acc, P) => acc + P[j], 0) / 4) as [number, number, number];
        let n = faceNormal(si.pts, f, si.center);
        const toC = [C[0] - fc[0], C[1] - fc[1], C[2] - fc[2]];
        const facing = n[0] * toC[0] + n[1] * toC[1] + n[2] * toC[2];
        if (flat && facing < 0) n = [-n[0], -n[1], -n[2]];
        else if (!flat && facing <= 0) continue;
        const c2 = f.map((i) => pr.corners![i]);
        if (c2.some((q) => !q)) continue;
        const d = c2.map((q, i) => { const v = toV(q!.x, q!.y); return `${i ? "L" : "M"}${lim(v.x).toFixed(1)} ${lim(v.y).toFixed(1)}`; }).join("") + "Z";
        fs.push({ d, fill: rgbHex(shade(n, base, wl, lgx)), depth: Math.hypot(toC[0], toC[1], toC[2]) });
      }
      fs.sort((a, b) => b.depth - a.depth);
      fs.forEach((f, i) => polys.push(<path key={`${id}-${i}`} d={f.d} fill={f.fill} fillOpacity={0.92} />));
    }
    shadeLayer = (
      <svg className="dir-svg dir-shade" width={vp.w} height={vp.h}>
        <rect x={fa.x} y={fa.y} width={bw} height={bh} fill={air} />
        {polys}
      </svg>
    );
  }
  const lightTitle = lgx?.enabled ? `${lgx.preset ? presetById(lgx.preset)?.name || "自定义" : "自定义"}` : "";

  const hz = proj.horizon ? clipLine(toV(proj.horizon.a.x, proj.horizon.a.y), toV(proj.horizon.b.x, proj.horizon.b.y), 0, 0, vp.w, vp.h) : null;
  const vpt = proj.vp ? toV(proj.vp.x, proj.vp.y) : null;
  const mask = `M0 0H${vp.w}V${vp.h}H0Z M${ox} ${oy}v${bh}h${bw}v${-bh}Z`;
  const horiz = mainSize.w >= mainSize.h * 1.15;
  const startSplit = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => {
      const r = mainRef.current!.getBoundingClientRect();
      const t = horiz ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      setPrefs({ split: Math.round(Math.max(0.2, Math.min(0.8, t)) * 1000) / 1000 });
    };
    const up = () => {
      el.removeEventListener("pointermove", mv);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", mv);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const corner = 14;

  return (
    <div className="director" onContextMenu={(e) => e.preventDefault()}>
      <header className="dir-top">
        <Clapperboard size={16} className="warm-text" />
        <span className="dir-title">镜头调度</span>
        <span className="muted ellipsis dir-page">{pageName}</span>
        <span className="chip warm ellipsis dir-phrase" title="编译时追加到整体描述的镜头语言">{phrase}</span>
        {lgx?.enabled && (
          <button type="button" className="chip dir-light-chip" title={lightingSummaryZh(lgx, cam).join("\n") || "灯光"} onClick={() => setPrefs({ tab: "light" })}>
            <Lightbulb size={11} /><span className="dlc-lbl ellipsis">{lightTitle}</span>
          </button>
        )}
        <div className="spacer" />
        <Seg small value={prefs.layout} onChange={(v) => setPrefs({ layout: v })} options={[
          { v: "shot", t: <><Square size={13} /><span className="bar-lbl">镜头</span></>, title: "只看镜头画面" },
          { v: "split", t: <><Columns2 size={13} /><span className="bar-lbl">分屏</span></>, title: "镜头画面 + 3D 场景并排" },
          { v: "scene", t: <><Box size={13} /><span className="bar-lbl">3D</span></>, title: "只看 3D 场景：自由视角，拖体块、镜头和灯" },
        ]} />
        <div className="bar-sep" />
        <Seg small value={prefs.tool} onChange={(v) => setPrefs({ tool: v })} options={[
          { v: "camera", t: <><Rotate3d size={13} /><span className="bar-lbl">机位</span></>, title: "拖拽画面转动机位（M 切换）" },
          { v: "move", t: <><Move size={13} /><span className="bar-lbl">体块</span></>, title: "拖动框移动 3D 体块，出画的也能拖回来；拖空白处仍可转机位（M 切换）" },
        ]} />
        {prefs.tool === "move" && <MoveModeMenu align="right" />}
        <div className="bar-sep" />
        <div className="btn-split">
          <button type="button" className="btn btn-sm btn-warm" onClick={() => runAuto("smart")} title="保持原构图；放不下时把全部体块收进画面（A）"><Wand2 size={13} /><span className="btn-lbl">自动取景</span></button>
          <button ref={auto.ref} type="button" className="btn btn-sm btn-warm btn-icon" onClick={auto.toggle}><ChevronDown size={13} /></button>
        </div>
        <Popover anchor={auto.ref.current} open={auto.open} onClose={auto.close} width={260} align="right">
          <MenuItem icon={<Wand2 size={13} />} onClick={() => runAuto("smart")} meta="A">智能取景（保持原构图）</MenuItem>
          <MenuItem icon={<ScanSearch size={13} />} onClick={() => runAuto("fit")}>全部收进画面</MenuItem>
          <MenuItem icon={<LocateFixed size={13} />} onClick={() => runAuto("subject")}>{selWorld.length ? "选中项" : "主体"}回到原位置和大小</MenuItem>
          <MenuItem icon={<Crosshair size={13} />} onClick={() => runAuto("center")}>{selWorld.length ? "选中项" : "主体"}居中（只平移）</MenuItem>
          <MenuItem icon={<Maximize2 size={13} />} disabled={!selWorld.length} onClick={() => { auto.close(); if (L) animateTo(solveFraming(L, cam, selWorld, { cx: W / 2, cy: H / 2, fit: { w: W * 0.7, h: H * 0.7 } })); }}>选中项充满画面</MenuItem>
        </Popover>
        <div className={cx("dir-follow", follow && "on")}>
          <Switch warm on={!!follow} onChange={toggleFollow} title="转动机位时自动平移，让主体保持在画面中的位置" />
          <span className="ellipsis" title={followNames}>{follow ? `跟随 · ${followNames}` : "跟随主体"}</span>
          <button ref={fol.ref} type="button" className="btn btn-ghost btn-xs btn-icon" onClick={fol.toggle}><ChevronDown size={12} /></button>
        </div>
        <Popover anchor={fol.ref.current} open={fol.open} onClose={fol.close} width={270} align="right">
          <div className="menu-note">开启后环绕 / 俯仰 / 改视角时，自动平移镜头，让目标停在画面中的同一位置。</div>
          <MenuItem active={prefs.keepSize} onClick={() => setPrefs({ keepSize: !prefs.keepSize })} meta={prefs.keepSize ? "开" : "关"}>同时保持景别（自动推拉）</MenuItem>
          <MenuItem disabled={!selWorld.length} onClick={() => { fol.close(); setFollow(null); setTimeout(() => toggleFollow(true)); }}>改为跟随当前选中（{selWorld.length}）</MenuItem>
          <MenuItem disabled={!follow} onClick={() => { fol.close(); recapture(cam); toast("已把当前位置设为跟随目标位置", "ok"); }}>把当前位置设为目标位置</MenuItem>
        </Popover>
        <div className="bar-sep" />
        <button ref={comp.ref} type="button" className="btn btn-sm" onClick={comp.toggle}><Grid3x3 size={13} /><span className="btn-lbl">构图</span><ChevronDown size={11} /></button>
        <Popover anchor={comp.ref.current} open={comp.open} onClose={comp.close} width={200} align="right">
          <MenuItem active={prefs.thirds} onClick={() => setPrefs({ thirds: !prefs.thirds })} meta={prefs.thirds ? "✓" : ""}>三分线</MenuItem>
          <MenuItem active={prefs.safe} onClick={() => setPrefs({ safe: !prefs.safe })} meta={prefs.safe ? "✓" : ""}>安全框 90%</MenuItem>
          <MenuItem active={prefs.ghost} onClick={() => setPrefs({ ghost: !prefs.ghost })} meta={prefs.ghost ? "✓" : ""}>原框虚影</MenuItem>
          <MenuItem active={showWire} onClick={() => setUi({ showWire: !showWire })} meta={showWire ? "✓" : ""}>3D 线框</MenuItem>
          <MenuItem active={prefs.outside} onClick={() => setPrefs({ outside: !prefs.outside })} meta={prefs.outside ? "✓" : ""}>显示画外内容</MenuItem>
          <MenuItem active={prefs.shade} onClick={() => setPrefs({ shade: !prefs.shade })} meta={prefs.shade ? "✓" : ""}>光影预览（开灯光时）</MenuItem>
        </Popover>
        <button type="button" className="btn btn-sm btn-icon" disabled={!canUndo} onClick={undo} title="撤销（Ctrl+Z）"><Undo2 size={14} /></button>
        <button type="button" className="btn btn-sm btn-icon" disabled={!canRedo} onClick={redo} title="重做（Ctrl+Shift+Z）"><Redo2 size={14} /></button>
        <button type="button" className="btn btn-sm" disabled={!moved} onClick={() => animateTo({ ...defaultCamera(), enabled: true })} title="回到初始机位"><RotateCcw size={13} /><span className="btn-lbl">重置</span></button>
        <button type="button" className="btn btn-sm" disabled={!moved} onClick={() => { setFollow(null); bakeCamera(); }} title="把当前镜头下的框写回原框，机位归零"><AnchorIcon size={13} /><span className="btn-lbl">定为基准</span></button>
        <AssistButton label="交给 Agent" onSent={() => { exit(); toast("已交给 Agent，结果在右侧面板", "ok"); }} />
        <div className="bar-sep" />
        <button type="button" className="btn btn-sm btn-icon" onClick={() => void toggleWindowFs()} title={fs ? "退出窗口全屏" : "窗口全屏"}>{fs ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={exit} title="退出镜头调度（Esc）"><X size={13} />完成</button>
      </header>

      <div ref={mainRef} className={cx("dir-main", `lay-${prefs.layout}`, horiz ? "dm-row" : "dm-col")}>
      <div ref={view} className={cx("dir-view", orbiting && `is-${orbiting}`, prefs.tool === "move" && hover && !orbiting && "can-move", shadeOn && "shading")}
        style={prefs.layout === "split" ? { flex: `${prefs.split} 1 0` } : undefined}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        onPointerCancel={() => { drag.current = null; setOrbiting(""); }} onPointerLeave={() => !drag.current && setHover(null)}>
        <div className="dir-frame" style={{ left: ox, top: oy, width: bw, height: bh }}>
          <div className="artboard-grid" />
        </div>
        {shadeLayer}
        {boxes}
        <svg className="dir-svg" width={vp.w} height={vp.h}>
          {hz && <line className="dir-horizon" x1={hz.x1} y1={hz.y1} x2={hz.x2} y2={hz.y2} />}
          {wires}
          {prefs.ghost && moved && L.items.map((it, k) => {
            if (it.hidden || bodyOf(it, L).anchor !== "world") return null;
            const a = toV(it.bbox[0], it.bbox[1]);
            return <rect key={it.id} className="dir-ghost" x={a.x} y={a.y} width={(it.bbox[2] - it.bbox[0]) * scale} height={(it.bbox[3] - it.bbox[1]) * scale} stroke={boxColor(it, k)} />;
          })}
          <path d={mask} className="dir-mask" fillRule="evenodd" style={{ fillOpacity: prefs.outside ? 0.5 : 0.94 }} />
          <rect className="dir-frame-line" x={ox} y={oy} width={bw} height={bh} />
          {[[ox, oy, 1, 1], [ox + bw, oy, -1, 1], [ox, oy + bh, 1, -1], [ox + bw, oy + bh, -1, -1]].map(([x, y, sx, sy], i) => (
            <path key={i} className="dir-corner" d={`M${x - sx * 4} ${y + sy * corner}V${y - sy * 4}H${x + sx * corner}`} />
          ))}
          {prefs.thirds && [1, 2].map((n) => (
            <g key={n} className="dir-thirds">
              <line x1={ox + (bw * n) / 3} x2={ox + (bw * n) / 3} y1={oy} y2={oy + bh} />
              <line y1={oy + (bh * n) / 3} y2={oy + (bh * n) / 3} x1={ox} x2={ox + bw} />
            </g>
          ))}
          {prefs.safe && <rect className="dir-safe" x={ox + bw * 0.05} y={oy + bh * 0.05} width={bw * 0.9} height={bh * 0.9} />}
          <g className="dir-center" transform={`translate(${ox + bw / 2} ${oy + bh / 2})`}><line x1={-7} x2={7} /><line y1={-7} y2={7} /></g>
          {follow && (() => {
            const g = toV(follow.goal.cx, follow.goal.cy);
            return <g className="dir-goal" transform={`translate(${g.x} ${g.y})`}><circle r={9} /><line x1={-14} x2={-5} /><line x1={5} x2={14} /><line y1={-14} y2={-5} /><line y1={5} y2={14} /></g>;
          })()}
          {vpt && moved && vpt.x > -20 && vpt.x < vp.w + 20 && vpt.y > -20 && vpt.y < vp.h + 20 && (
            <g className="dir-vp" transform={`translate(${vpt.x} ${vpt.y})`}><circle r={5} /><line x1={-9} x2={9} /><line y1={-9} y2={9} /></g>
          )}
        </svg>
        {labels}
        <div className="dir-frame-cap num" style={{ left: ox, top: Math.min(vp.h - HUD - 24, oy + bh + 8) }}>
          <span>画框 {W} × {H}</span>
          <span className="muted">{framingZoom(cam).toFixed(2)}× · {Math.round(equivFocal(cam.fov, W, H))}mm</span>
        </div>
        <div className="dir-hud">
          <span className="dir-hint">{prefs.tool === "move"
            ? "体块模式 · 拖框 移动体块（成组的整组动，Alt 只动这一个） · 拖空白处 环绕 · Shift/右键拖 平移 · 方向键 微移选中 · M 切换"
            : "拖拽 环绕/俯仰 · Shift/右键拖 平移 · 滚轮 推拉 · Alt+滚轮 视角 · Shift+滚轮 滚转 · Ctrl+滚轮 视野 · 方向键 微调 · M 体块模式"}</span>
          <div className="spacer" />
          <button type="button" className="btn btn-xs btn-ghost num" onClick={() => setViewZoom(1)} title="视野缩放（Ctrl+滚轮），点此复原">视野 {Math.round(viewZoom * 100)}%</button>
          {outCount + partCount > 0 ? (
            <span className="dir-warn"><AlertTriangle size={13} />{outCount > 0 && `${outCount} 个出画`}{outCount > 0 && partCount > 0 && "，"}{partCount > 0 && `${partCount} 个部分出画`}
              <button type="button" className="btn btn-xs btn-warm" onClick={() => runAuto("smart")} title="动机位，让体块回到画面里"><Wand2 size={11} />自动取景</button>
              {outCount > 0 && (
                <button type="button" className="btn btn-xs" onClick={() => bringAllIntoFrame()} title="镜头不动，把完全出画的体块（连同同组的框）挪回画面里"><Magnet size={11} />拉回画面</button>
              )}
            </span>
          ) : (
            <span className="dir-ok"><CheckCircle2 size={13} />全部在画内</span>
          )}
        </div>
      </div>
      {prefs.layout === "split" && <div className="dir-splitter" onPointerDown={startSplit} title="拖动调整两边大小，双击平分" onDoubleClick={() => setPrefs({ split: 0.5 })} />}
      {prefs.layout !== "shot" && (
        <div className="dir-scene" style={prefs.layout === "split" ? { flex: `${1 - prefs.split} 1 0` } : undefined}>
          <SceneView L={L} cam={cam} pageId={pageId} selection={selection} hover={hover} setHover={setHover} onCam={(p, key) => applyCam(p, key)}
            activeLight={activeLight} setActiveLight={(id) => { setActiveLight(id); if (id) setPrefs({ tab: "light" }); }} />
        </div>
      )}
      </div>

      <aside className="dir-side">
        <div className="dir-tabs">
          {([
            ["camera", <><CameraIcon size={13} />机位</>],
            ["light", <><Lightbulb size={13} />灯光{lgx?.enabled && <span className="dir-tab-dot" />}</>],
            ["body", <><Box size={13} />体块{selection.length === 1 && <span className="dir-tab-dot sel" />}</>],
          ] as [Prefs["tab"], React.ReactNode][]).map(([v, t]) => (
            <button key={v} type="button" className={cx("dir-tab", prefs.tab === v && "on")} onClick={() => setPrefs({ tab: v })}>{t}</button>
          ))}
        </div>
        {prefs.tab === "light" && <LightingPanel L={L} cam={cam} active={activeLight} setActive={setActiveLight} onSent={() => { exit(); toast("已交给 Agent，结果在右侧面板", "ok"); }} />}
        {prefs.tab === "body" && <BodyPanel L={L} cam={cam} selection={selection} onFrame={frameItem} />}
        {prefs.tab === "camera" && <>
        <section className="dir-sec">
          <div className="dir-sec-head">
            <span className="section-title">机位</span>
            <div className="spacer" />
            <button ref={pre.ref} type="button" className="btn btn-xs" onClick={pre.toggle}>预设<ChevronDown size={11} /></button>
            <Popover anchor={pre.ref.current} open={pre.open} onClose={pre.close} width={180} align="right">
              {CAMERA_PRESETS.map((p) => (
                <MenuItem key={p.name} onClick={() => {
                  pre.close();
                  let next = clampCamera({ ...defaultCamera(), ...p.cam, enabled: true });
                  if (followRef.current) next = solveFollow(L, next);
                  animateTo(next);
                }}>{p.name}</MenuItem>
              ))}
            </Popover>
          </div>
          <div className="dir-cam">
            <Gizmo cam={cam} subjectYaw={subj ? bodyOf(subj, L).yaw : 0} size={150} onCam={(p, key) => applyCam(p, key)} />
            <div className="dir-stats">
              <div><span className="muted">景别</span><b className="num">{framingZoom(cam).toFixed(2)}×</b></div>
              <div title="按画面对角线换算的 35mm 等效焦距"><span className="muted">等效焦距</span><b className="num">{Math.round(equivFocal(cam.fov, W, H))} mm</b></div>
              <div title="主体投影高度占画面高度"><span className="muted">主体画高</span><b className="num">{subjBox ? `${Math.round(((subjBox[3] - subjBox[1]) / H) * 100)}%` : "—"}</b></div>
              <div><span className="muted">出画</span><b className={cx("num", outCount + partCount > 0 && "warm-text")}>{outCount + partCount}</b></div>
            </div>
          </div>
          <div className="dir-dials">
            {ROWS.map((r) => {
              const [lo, hi] = CAMERA_LIMITS[r.k];
              return (
                <Dial key={r.k} warm label={r.label} title={r.title} value={cam[r.k]} min={lo} max={hi} step={r.step} unit={r.unit}
                  log={r.log} digits={r.digits} zero={r.zero}
                  onChange={(v) => applyCam({ [r.k]: v } as Partial<Camera>, `dir-dial-${r.k}`)}
                  onReset={() => applyCam({ [r.k]: defaultCamera()[r.k] } as Partial<Camera>, "")} />
              );
            })}
          </div>
        </section>
        <section className="dir-sec">
          <div className="dir-sec-head">
            <span className="section-title">俯视图</span>
            <span className="hint">{prefs.tool === "move" ? "拖体块在地面上移动 · 拖机位转镜头" : "拖动机位或点空白处放置"}</span>
          </div>
          <PlanMap L={L} cam={cam} selection={selection} onCam={(p, key) => applyCam(p, key)} moveMode={prefs.tool === "move"}
            onMoved={() => { if (followRef.current) recapture(clampCamera(useStore.getState().doc?.layout.camera || defaultCamera())); }} />
        </section>
        <section className="dir-sec">
          <div className="dir-sec-head">
            <span className="section-title">画面里的框</span>
            <div className="spacer" />
            <span className="hint">双击取景到它</span>
          </div>
          <div className="dir-list">
            {rows.map(({ it, i, st }) => (
              <button key={it.id} type="button" className={cx("dir-row", selSet.has(it.id) && "sel", hover === it.id && "hover")}
                onMouseEnter={() => setHover(it.id)} onMouseLeave={() => setHover(null)}
                onClick={(e) => select(e.ctrlKey || e.metaKey || e.shiftKey ? (selSet.has(it.id) ? selection.filter((x) => x !== it.id) : [...selection, it.id]) : [it.id])}
                onDoubleClick={() => st && st !== "fixed" && frameItem(it.id)}>
                <span className="dot" style={{ background: boxColor(it, i) }} />
                <span className="ellipsis">{itemName(it, i)}</span>
                <span className="muted dir-row-kind">{LABEL_TEXT[it.label]}</span>
                <span className={cx("dir-st", st || "hidden")}>{st ? STATUS_TEXT[st] : "隐藏"}</span>
                {st && (st === "out" || st === "behind" || st === "partial") && !it.locked && (
                  <span className="dir-row-act" role="button" title="拉回画面：镜头不动，把它（连同同组的框）挪进画面" onClick={(e) => { e.stopPropagation(); bringIntoFrame(it.id); }}><Magnet size={12} /></span>
                )}
                {st && st !== "fixed" && (
                  <span className="dir-row-act" role="button" title="取景到它（动机位）" onClick={(e) => { e.stopPropagation(); frameItem(it.id); }}><Eye size={12} /></span>
                )}
              </button>
            ))}
          </div>
        </section>
        </>}
        <div className="dir-side-foot">
          <Move3d size={12} />
          <span>机位改动和主画布同步，可撤销；退出后在主画布看到相同结果。</span>
        </div>
      </aside>
    </div>
  );
}
