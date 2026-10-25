/**
 * 镜头调度室 · 3D 场景：自由视角看整个场景（体块、拍摄镜头的视锥和画框、灯位），
 * 在这里直接拖体块（地面上平移，Shift 上下）、拖镜头、拖灯。所有改动和主画布同步、可撤销。
 */
import { Box, Camera as CameraIcon, Grid3x3, Lightbulb, SunDim } from "lucide-react";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cameraMoved, moveTargets, sceneData, translateItems, wrapDeg, type Vec3 } from "../lib/camera";
import { boxColor, itemName } from "../lib/doc";
import { normalizeLighting, vecAngles } from "../lib/lighting";
import {
  drawScene, lightPos, obsFrame, pointInPoly, presetObs, rayAt, rayPlane, raySphere, v3, type DrawItem, type HitMap, type Obs, type ObsPreset,
} from "../lib/scene3d";
import { applyMove, select, setLighting, toast, useStore, withGroup } from "../store";
import type { Camera, LayoutDraft } from "../types";
import { cx } from "../ui";

type V3 = Vec3;
const OBS = new Map<string, Obs>();
const PREF_KEY = "moss.scene.prefs";
interface ScenePrefs { grid: boolean; lights: boolean; shadows: boolean }
const loadPrefs = (): ScenePrefs => {
  const d = { grid: true, lights: true, shadows: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") }; } catch { return d; }
};

const PRESETS: { v: ObsPreset; t: string; title: string }[] = [
  { v: "persp", t: "透视", title: "斜上方看整个场景（双击空白处也会回到这里）" },
  { v: "top", t: "顶视", title: "从正上方看：站位、机位和灯位" },
  { v: "front", t: "正面", title: "从机位方向看过去" },
  { v: "side", t: "侧面", title: "从侧面看：前后距离、高度" },
  { v: "shot", t: "机位", title: "从拍摄镜头的位置看（和画面一致）" },
];

export function SceneView({ L, cam, pageId, selection, hover, setHover, onCam, activeLight, setActiveLight }: {
  L: LayoutDraft;
  cam: Camera;
  pageId: string;
  selection: string[];
  hover: string | null;
  setHover: (id: string | null) => void;
  onCam: (p: Partial<Camera>, key?: string) => void;
  activeLight: string | null;
  setActiveLight: (id: string | null) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [prefs, setPrefsState] = useState<ScenePrefs>(loadPrefs);
  const setPrefs = (p: Partial<ScenePrefs>) => setPrefsState((o) => {
    const n = { ...o, ...p };
    try { localStorage.setItem(PREF_KEY, JSON.stringify(n)); } catch { /* ignore */ }
    return n;
  });
  const sd = useMemo(() => sceneData(L, cam), [L, cam]);
  const lighting = useMemo(() => (L.lighting ? normalizeLighting(L.lighting) : null), [L.lighting]);
  const [obs, setObsState] = useState<Obs | null>(() => OBS.get(pageId) || null);
  const obsRef = useRef<Obs | null>(obs);
  obsRef.current = obs;
  const setObs = (o: Obs) => { OBS.set(pageId, o); obsRef.current = o; setObsState(o); };
  const anim = useRef(0);
  const hit = useRef<HitMap | null>(null);
  const [cursor, setCursor] = useState("");
  const [mode, setMode] = useState<"" | "orbit" | "pan" | "item" | "cam" | "light">("");

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((en) => {
      const r = en[0].contentRect;
      const w = Math.floor(r.width), h = Math.floor(r.height);
      setSize((p) => (p.w === w && p.h === h ? p : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 切页 / 第一次量到尺寸：取默认视角
  useEffect(() => {
    if (!size.w || !size.h) return;
    const o = OBS.get(pageId);
    if (o) { obsRef.current = o; setObsState(o); }
    else setObs(presetObs(sd, cam, "persp", size.w / size.h));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, size.w > 0 && size.h > 0]);

  const animateObs = (to: Obs) => {
    cancelAnimationFrame(anim.current);
    const from = obsRef.current || to;
    const t0 = performance.now();
    const dy = wrapDeg(to.yaw - from.yaw);
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 280);
      const k = 1 - Math.pow(1 - t, 3);
      const lerp = (a: number, b: number) => a + (b - a) * k;
      setObs({
        yaw: from.yaw + dy * k, pitch: lerp(from.pitch, to.pitch), fov: lerp(from.fov, to.fov),
        dist: Math.exp(lerp(Math.log(from.dist), Math.log(to.dist))),
        target: [lerp(from.target[0], to.target[0]), lerp(from.target[1], to.target[1]), lerp(from.target[2], to.target[2])],
      });
      if (t < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  };
  useEffect(() => () => cancelAnimationFrame(anim.current), []);
  const goPreset = (k: ObsPreset) => animateObs(presetObs(sd, cam, k, size.w / Math.max(1, size.h)));

  const items = useMemo(() => {
    const m = new Map<string, DrawItem>();
    L.items.forEach((it, i) => m.set(it.id, { id: it.id, color: boxColor(it, i), index: i, name: itemName(it, i), hidden: !!it.hidden, locked: !!it.locked }));
    return m;
  }, [L.items]);
  const moved = cameraMoved(L);
  const selSet = useMemo(() => new Set(selection), [selection]);

  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c || !obs || !size.w || !size.h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(size.w * dpr) || c.height !== Math.round(size.h * dpr)) {
      c.width = Math.round(size.w * dpr);
      c.height = Math.round(size.h * dpr);
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    hit.current = drawScene(ctx, {
      sd, items, F: obsFrame(obs, size.w, size.h), cam, moved, lighting, selection: selSet, hover, grid: prefs.grid,
      showLights: prefs.lights, shadows: prefs.shadows, activeLight, dpr,
    });
    (c as unknown as { __hit?: HitMap }).__hit = hit.current; // 供自动化测试读取命中区域
  }, [sd, items, obs, size, cam, moved, lighting, selSet, hover, prefs, activeLight]);

  // ---------- 命中 ----------
  type Hit = { kind: "light"; id: string } | { kind: "cam" } | { kind: "item"; id: string } | null;
  const hitTest = (x: number, y: number): Hit => {
    const h = hit.current;
    if (!h) return null;
    for (let i = h.lights.length - 1; i >= 0; i--) if (Math.hypot(h.lights[i].x - x, h.lights[i].y - y) < 13) return { kind: "light", id: h.lights[i].id };
    if (h.camera && Math.hypot(h.camera.x - x, h.camera.y - y) < 12) return { kind: "cam" };
    for (let i = h.items.length - 1; i >= 0; i--) if (pointInPoly(x, y, h.items[i].poly)) return { kind: "item", id: h.items[i].id };
    return null;
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const drag = useRef<null | {
    kind: "orbit" | "pan" | "item" | "cam" | "light"; x: number; y: number; moved: boolean; key: string; obs: Obs;
    ids?: string[]; base?: LayoutDraft; P0?: V3; plane?: { P: V3; n: V3 }; vertical?: boolean;
    cam0?: Camera; a0?: number; r0?: number; T?: V3;
    light?: string; far?: boolean; add?: boolean; clickId?: string | null;
  }>(null);

  const onDown = (e: React.PointerEvent) => {
    if (e.button > 2 || !obs) return;
    if ((e.target as HTMLElement).closest(".scene-ui")) return;
    e.preventDefault();
    e.stopPropagation();
    cancelAnimationFrame(anim.current);
    wrap.current!.setPointerCapture(e.pointerId);
    const p = local(e);
    const F = obsFrame(obs, size.w, size.h);
    const key = `scene${Date.now()}`;
    const base = { x: e.clientX, y: e.clientY, moved: false, key, obs };
    const pan = e.button === 1 || e.button === 2 || (e.shiftKey && e.button === 0 && !hitTest(p.x, p.y));
    const h = e.button === 0 ? hitTest(p.x, p.y) : null;
    if (h?.kind === "light" && lighting) {
      setActiveLight(h.id);
      const P = lightPos(sd, lighting, cam, h.id);
      const S = hit.current!.lightCenter;
      const far = !!P && v3.dot(v3.sub(P, S), v3.sub(F.eye, S)) < 0;
      drag.current = { ...base, kind: "light", light: h.id, far };
      return;
    }
    if (h?.kind === "cam") {
      const C = sd.frame.C;
      const r = rayAt(F, p.x, p.y);
      const P = rayPlane(r, C, [0, 1, 0]) || C;
      const T = sd.pivot;
      const v = [P[0] - T[0], P[2] - T[2]];
      drag.current = { ...base, kind: "cam", cam0: { ...cam }, a0: Math.atan2(v[0], -v[1]), r0: Math.max(1e-6, Math.hypot(v[0], v[1])), T };
      return;
    }
    if (h?.kind === "item") {
      const st = useStore.getState();
      const id = h.id;
      const solo = e.altKey;
      const sel = st.selection;
      const unit = withGroup([id], solo);
      const add = e.ctrlKey || e.metaKey;
      const ids = add ? (sel.includes(id) ? sel.filter((x) => !unit.includes(x)) : [...sel, ...unit.filter((x) => !sel.includes(x))])
        : sel.includes(id) && !solo ? sel : unit;
      select(ids);
      const it = L.items.find((x) => x.id === id);
      const si = sd.items.find((x) => x.id === id);
      if (!it || !si || si.anchor !== "world" || add || !ids.includes(id)) { drag.current = null; return; }
      const t = moveTargets(L, ids, st.moveScope, id, solo);
      if (!t.ids.length) {
        if (t.pinned) toast("锁定的框（或组里有锁定的框）不能移动");
        drag.current = null;
        return;
      }
      const r = rayAt(F, p.x, p.y);
      const vertical = e.shiftKey;
      const hf = v3.norm([F.fwd[0], 0, F.fwd[2]]);
      const plane = vertical ? { P: si.center, n: (Math.hypot(F.fwd[0], F.fwd[2]) > 1e-3 ? hf : [0, 0, 1]) as V3 } : { P: si.center, n: [0, 1, 0] as V3 };
      const P0 = rayPlane(r, plane.P, plane.n);
      if (!P0) { drag.current = null; return; }
      drag.current = { ...base, kind: "item", ids: t.ids, base: L, P0, plane, vertical };
      return;
    }
    drag.current = { ...base, kind: pan ? "pan" : "orbit", add: e.ctrlKey || e.metaKey };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const p = local(e);
    if (!d) {
      const h = hitTest(p.x, p.y);
      const id = h?.kind === "item" ? h.id : null;
      if (id !== hover) setHover(id);
      setCursor(h?.kind === "item" ? (sd.items.find((x) => x.id === id)?.anchor === "world" ? "move" : "pointer") : h ? "grab" : "");
      return;
    }
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    if (!d.moved) { d.moved = true; setMode(d.kind); }
    const o = d.obs;
    if (d.kind === "orbit") {
      setObs({ ...o, yaw: o.yaw + dx * 0.35, pitch: Math.max(-89, Math.min(89, o.pitch + dy * 0.3)) });
    } else if (d.kind === "pan") {
      const F = obsFrame(o, size.w, size.h);
      const k = o.dist / F.f;
      setObs({ ...o, target: v3.add(o.target, v3.add(v3.mul(F.right, -dx * k), v3.mul(F.down, -dy * k))) });
    } else if (d.kind === "item") {
      const F = obsFrame(o, size.w, size.h);
      const P = rayPlane(rayAt(F, p.x, p.y), d.plane!.P, d.plane!.n);
      if (!P) return;
      let T: V3 = v3.sub(P, d.P0!);
      T = d.vertical ? [0, T[1], 0] : [T[0], 0, T[2]];
      const lim = sd.D0 * 12;
      if (v3.len(T) > lim) T = v3.mul(v3.norm(T), lim);
      applyMove(translateItems(d.base!, d.ids!, T, useStore.getState().moveHold), d.key);
    } else if (d.kind === "cam") {
      const c0 = d.cam0!;
      if (e.shiftKey) {
        onCam({ pitch: c0.pitch + dy * 0.3 }, d.key);
        return;
      }
      const F = obsFrame(o, size.w, size.h);
      const P = rayPlane(rayAt(F, p.x, p.y), sd.frame.C, [0, 1, 0]);
      if (!P) return;
      const v = [P[0] - d.T![0], P[2] - d.T![2]];
      const a = Math.atan2(v[0], -v[1]);
      onCam({ orbit: wrapDeg(c0.orbit + ((a - d.a0!) * 180) / Math.PI), distance: c0.distance * (Math.hypot(v[0], v[1]) / d.r0!) }, d.key);
    } else if (d.kind === "light" && lighting) {
      const F = obsFrame(o, size.w, size.h);
      const S = hit.current!.lightCenter, R = hit.current!.lightRadius;
      const P = raySphere(rayAt(F, p.x, p.y), S, R, !!d.far);
      const a = vecAngles(v3.sub(P, S));
      const follow = lighting.follow;
      const az = wrapDeg(a.azimuth - (follow && cam.enabled ? cam.orbit : 0));
      const id = d.light!;
      setLighting((lg) => ({ preset: "", lights: lg.lights.map((l) => (l.id === id ? { ...l, azimuth: Math.round(az * 10) / 10, elevation: a.elevation } : l)) }), d.key);
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setMode("");
    if (!d || d.moved || e.button !== 0) return;
    if (d.kind === "orbit") {
      const p = local(e);
      if (!hitTest(p.x, p.y) && !d.add) select([]);
    }
  };

  const onDbl = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".scene-ui") || !obs) return;
    const p = local(e);
    const h = hitTest(p.x, p.y);
    if (h?.kind === "item") {
      const si = sd.items.find((x) => x.id === h.id);
      if (si) animateObs({ ...obs, target: si.center });
      return;
    }
    if (!h) goPreset("persp");
  };

  // 滚轮缩放（非被动监听，阻止 WebView 缩放）
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    if ((e.target as HTMLElement).closest(".scene-ui")) return;
    e.preventDefault();
    const o = obsRef.current;
    if (!o) return;
    const dv = e.deltaY || e.deltaX;
    if (!dv) return;
    cancelAnimationFrame(anim.current);
    setObs({ ...o, dist: Math.max(sd.D0 * 0.05, Math.min(sd.D0 * 60, o.dist * (dv > 0 ? 1.1 : 1 / 1.1))) });
  };
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fn = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", fn, { passive: false });
    return () => el.removeEventListener("wheel", fn);
  }, []);

  const lgOn = !!lighting?.enabled;
  const nSel = selection.length;
  const selName = nSel === 1 ? (() => { const k = L.items.findIndex((x) => x.id === selection[0]); return k >= 0 ? itemName(L.items[k], k) : ""; })() : "";

  return (
    <div ref={wrap} className={cx("scene-view", mode && `is-${mode}`)} style={{ cursor: mode ? undefined : cursor || undefined }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={onDbl}
      onPointerCancel={() => { drag.current = null; setMode(""); }} onPointerLeave={() => !drag.current && hover && setHover(null)}
      onContextMenu={(e) => e.preventDefault()}>
      <canvas ref={canvas} className="scene-canvas" style={{ width: size.w, height: size.h }} />
      <div className="scene-ui scene-top">
        <span className="scene-title"><Box size={12} />3D 场景</span>
        <div className="scene-seg">
          {PRESETS.map((p) => (
            <button key={p.v} type="button" title={p.title} onClick={() => goPreset(p.v)}>
              {p.v === "shot" && <CameraIcon size={11} />}{p.t}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button type="button" className={cx("scene-tg", prefs.grid && "on")} onClick={() => setPrefs({ grid: !prefs.grid })} title="地面网格（每格约 1 米，按主体身高换算）"><Grid3x3 size={13} /></button>
        <button type="button" className={cx("scene-tg", prefs.shadows && "on")} onClick={() => setPrefs({ shadows: !prefs.shadows })} title="地面阴影（按主光方向投影）"><SunDim size={13} /></button>
        <button type="button" className={cx("scene-tg", prefs.lights && "on")} disabled={!lgOn} onClick={() => setPrefs({ lights: !prefs.lights })} title={lgOn ? "显示灯位（可直接拖动）" : "灯光未开启：在右侧「灯光」里打开"}><Lightbulb size={13} /></button>
      </div>
      {selName && <div className="scene-ui scene-sel"><span className="dot" style={{ background: items.get(selection[0])?.color }} />{selName}</div>}
      <div className="scene-ui scene-hint">
        拖空白 环绕 · 右键/Shift 拖 平移 · 滚轮 缩放 · 双击 复位 · 拖体块 地面移动（Shift 上下） · 拖<b className="warm-text">镜头</b>转机位（Shift 俯仰）{lgOn ? " · 拖灯 改方向" : ""}
      </div>
    </div>
  );
}
