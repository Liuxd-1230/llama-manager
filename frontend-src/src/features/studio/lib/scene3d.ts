/**
 * 镜头调度室的 3D 场景视图：观察者相机（环绕 / 平移 / 缩放）、近平面裁剪、Canvas 2D 绘制。
 * 世界坐标和 camera.ts 一致：x 右、y 下、z 朝画面里；初始拍摄机位在原点看 +z。
 */
import { CUBE_FACES, faceNormal, type SceneData, type SceneFrame, type Vec3 } from "./camera";
import { ROLES, backdropShade, hexRgb, kelvinRgb, lightVec, rgbHex, shade, worldAzimuth, type RGB, type WorldLight } from "./lighting";
import type { Camera, Lighting } from "../types";

type V3 = Vec3;
const rad = (d: number) => (d * Math.PI) / 180;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const v3 = { add, sub, mul, dot, cross, len, norm };

// ---------- 观察者相机 ----------
export interface Obs {
  yaw: number;
  pitch: number;
  dist: number;
  target: V3;
  fov: number;
}

export interface ObsFrame {
  eye: V3;
  right: V3;
  down: V3;
  fwd: V3;
  f: number;
  w: number;
  h: number;
  near: number;
}

export function obsFrame(o: Obs, w: number, h: number): ObsFrame {
  const y = rad(o.yaw), p = rad(Math.max(-89.5, Math.min(89.5, o.pitch)));
  const dir: V3 = [Math.sin(y) * Math.cos(p), -Math.sin(p), -Math.cos(y) * Math.cos(p)];
  const fwd = mul(dir, -1);
  const right = norm(cross(fwd, [0, -1, 0]));
  const down = cross(fwd, right);
  return { eye: add(o.target, mul(dir, o.dist)), right, down, fwd, f: h / 2 / Math.tan(rad(o.fov) / 2), w, h, near: Math.max(1e-3, o.dist * 0.01) };
}

export const toCam = (F: ObsFrame, P: V3): V3 => {
  const r = sub(P, F.eye);
  return [dot(r, F.right), dot(r, F.down), dot(r, F.fwd)];
};
export const camProj = (F: ObsFrame, c: V3) => ({ x: F.w / 2 + (F.f * c[0]) / c[2], y: F.h / 2 + (F.f * c[1]) / c[2] });
export function projectPt(F: ObsFrame, P: V3): { x: number; y: number; z: number } | null {
  const c = toCam(F, P);
  if (c[2] < F.near) return null;
  return { ...camProj(F, c), z: c[2] };
}
/** 屏幕像素 → 世界射线 */
export function rayAt(F: ObsFrame, px: number, py: number): { o: V3; d: V3 } {
  return { o: F.eye, d: norm(add(F.fwd, add(mul(F.right, (px - F.w / 2) / F.f), mul(F.down, (py - F.h / 2) / F.f)))) };
}
export function rayPlane(r: { o: V3; d: V3 }, P0: V3, n: V3): V3 | null {
  const den = dot(r.d, n);
  if (Math.abs(den) < 1e-6) return null;
  const t = dot(sub(P0, r.o), n) / den;
  if (t <= 0) return null;
  return add(r.o, mul(r.d, t));
}
/** 射线和球：far = 取远侧交点；没交到时取轮廓上最近的点 */
export function raySphere(r: { o: V3; d: V3 }, S: V3, R: number, far: boolean): V3 {
  const oc = sub(r.o, S);
  const b = dot(r.d, oc);
  const c = dot(oc, oc) - R * R;
  const disc = b * b - c;
  if (disc >= 0) {
    const t = far ? -b + Math.sqrt(disc) : -b - Math.sqrt(disc);
    if (t > 0) return add(r.o, mul(r.d, t));
  }
  const tc = Math.max(0, -b);
  const q = add(r.o, mul(r.d, tc));
  return add(S, mul(norm(sub(q, S)), R));
}

/** 多边形在相机空间里裁到近平面前面 */
function clipNear(pts: V3[], near: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ia = a[2] >= near, ib = b[2] >= near;
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = (near - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, near]);
    }
  }
  return out;
}
function clipSeg(a: V3, b: V3, near: number): [V3, V3] | null {
  if (a[2] < near && b[2] < near) return null;
  if (a[2] >= near && b[2] >= near) return [a, b];
  const t = (near - a[2]) / (b[2] - a[2]);
  const m: V3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, near];
  return a[2] < near ? [m, b] : [a, m];
}

/** 世界多边形 → 屏幕多边形（裁剪后）；全在后面返回 null */
export function screenPoly(F: ObsFrame, pts: V3[]): { x: number; y: number }[] | null {
  const c = clipNear(pts.map((P) => toCam(F, P)), F.near);
  if (c.length < 3) return null;
  return c.map((p) => camProj(F, p));
}

export function pointInPoly(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function hull(pts: { x: number; z: number }[]): { x: number; z: number }[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.z - b.z);
  if (p.length < 3) return p;
  const crs = (o: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lo: typeof p = [], hi: typeof p = [];
  for (const q of p) {
    while (lo.length >= 2 && crs(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (hi.length >= 2 && crs(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop();
    hi.push(q);
  }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}

// ---------- 场景视角 ----------
export type ObsPreset = "persp" | "top" | "front" | "side" | "shot";

/** 场景里需要看到的点：体块、镜头、画框 */
function keyPoints(sd: SceneData): V3[] {
  const pts: V3[] = [];
  for (const it of sd.items) if (it.anchor === "world") pts.push(...it.pts);
  const fr = sd.frame;
  pts.push(fr.C, sd.pivot);
  for (const [u, v] of [[0, 0], [fr.W, 0], [fr.W, fr.H], [0, fr.H]]) pts.push(framePt(fr, u, v, sd.planeDepth));
  pts.push(sd.base.C);
  return pts;
}

export function framePt(fr: SceneFrame, u: number, v: number, depth: number): V3 {
  return add(fr.C, mul(add(fr.fwd, add(mul(fr.right, (u - fr.W / 2) / fr.f), mul(fr.down, (v - fr.H / 2) / fr.f))), depth));
}

export function presetObs(sd: SceneData, cam: Camera, kind: ObsPreset, aspect = 1.5): Obs {
  const fov = 40;
  if (kind === "shot") {
    const c = sd.frame;
    const d = sd.planeDepth;
    return { yaw: cam.orbit, pitch: cam.pitch, dist: d, target: add(c.C, mul(c.fwd, d)), fov: Math.max(15, Math.min(100, cam.fov)) };
  }
  const pts = keyPoints(sd);
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
  const c: V3 = mul(add(lo, hi), 0.5);
  const R = Math.max(sd.D0 * 0.3, ...pts.map((p) => len(sub(p, c))));
  const k = Math.min(1, aspect);
  const dist = (R / Math.sin(rad(fov / 2)) / Math.max(0.6, k)) * 1.08;
  const o = cam.orbit;
  if (kind === "top") return { yaw: o, pitch: 89, dist, target: c, fov };
  if (kind === "front") return { yaw: o, pitch: 6, dist, target: c, fov };
  if (kind === "side") return { yaw: o + 90, pitch: 6, dist, target: c, fov };
  return { yaw: o - 52, pitch: 26, dist, target: c, fov };
}

// ---------- 绘制 ----------
export interface DrawItem {
  id: string;
  color: string;
  index: number;
  name: string;
  hidden: boolean;
  locked: boolean;
}

export interface DrawOpts {
  sd: SceneData;
  items: Map<string, DrawItem>;
  F: ObsFrame;
  cam: Camera;
  moved: boolean;
  lighting: Lighting | null;
  selection: Set<string>;
  hover: string | null;
  grid: boolean;
  showLights: boolean;
  shadows: boolean;
  activeLight: string | null;
  dpr: number;
}

export interface HitMap {
  items: { id: string; poly: { x: number; y: number }[] }[];
  camera: { x: number; y: number } | null;
  lights: { id: string; x: number; y: number }[];
  lightCenter: V3;
  lightRadius: number;
}

/** 没开灯光时的展示用光：左上前方的柔光 + 环境 */
const DISPLAY_LG: Lighting = { enabled: true, preset: "", lights: [], ambient: 0.55, ambient_kelvin: 6200, extras: [], note: "", follow: false };
const DISPLAY_WL: WorldLight[] = [{ id: "d", role: "key", intensity: 0.75, softness: 0.6, rgb: [1, 0.98, 0.95], L: norm([-0.45, -0.8, -0.4]) }];

const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgba = (c: RGB, a: number) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

export function lightAnchor(sd: SceneData): { S: V3; R: number } {
  const subj = sd.items.filter((x) => x.anchor === "world");
  let S: V3 = sd.pivot;
  if (subj.length) {
    // 主体中心：pivot 所在深度附近最大的体块
    let best = subj[0], bestA = -1;
    for (const it of subj) {
      const ys = it.pts.map((p) => p[1]), xs = it.pts.map((p) => p[0]);
      const a = (Math.max(...ys) - Math.min(...ys)) * (Math.max(...xs) - Math.min(...xs)) / (1 + Math.abs(it.center[2] - sd.pivot[2]) / sd.D0);
      if (a > bestA) { bestA = a; best = it; }
    }
    S = best.center;
  }
  return { S, R: sd.D0 * 0.55 };
}

export function lightPos(sd: SceneData, lg: Lighting, cam: Camera, id: string): V3 | null {
  const l = lg.lights.find((x) => x.id === id);
  if (!l) return null;
  const { S, R } = lightAnchor(sd);
  return add(S, mul(lightVec(worldAzimuth(l, lg, cam), l.elevation), R));
}

export function drawScene(ctx: CanvasRenderingContext2D, o: DrawOpts): HitMap {
  const { sd, F, dpr } = o;
  const W = F.w, H = F.h;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const bg = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
  bg.addColorStop(0, "#3b3732");
  bg.addColorStop(1, "#211f1c");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const lgOn = !!o.lighting?.enabled && o.lighting.lights.some((l) => l.enabled);
  const lg = lgOn ? o.lighting! : DISPLAY_LG;
  const wl = lgOn ? (o.lighting!.lights.filter((l) => l.enabled && l.intensity > 0.02).map((l) => ({
    id: l.id, role: l.role, intensity: l.intensity, softness: l.softness,
    rgb: l.kelvin !== null ? hexRgbK(l.kelvin) : hexRgb(l.color), L: lightVec(worldAzimuth(l, o.lighting!, o.cam), l.elevation),
  })) as WorldLight[]) : DISPLAY_WL;

  // ---- 地面网格 ----
  const g = sd.ground;
  const step = niceStep(sd.meter);
  if (o.grid) {
    const ctr: V3 = add(F.eye, mul(F.fwd, Math.max(sd.D0 * 0.5, len(sub(sd.pivot, F.eye)) * 0.6)));
    const cxg = Math.round(ctr[0] / step) * step, czg = Math.round(ctr[2] / step) * step;
    const N = Math.min(60, Math.max(14, Math.ceil((sd.D0 * 3.2) / step)));
    const ext = N * step;
    ctx.lineWidth = 1;
    const seg = 10;
    for (let k = -N; k <= N; k++) {
      for (const axis of [0, 1]) {
        const major = (Math.round((axis ? czg : cxg) / step) + k) % 5 === 0;
        for (let s = 0; s < seg; s++) {
          const t0 = -ext + (2 * ext * s) / seg, t1 = -ext + (2 * ext * (s + 1)) / seg;
          const A: V3 = axis ? [cxg + t0, g, czg + k * step] : [cxg + k * step, g, czg + t0];
          const B: V3 = axis ? [cxg + t1, g, czg + k * step] : [cxg + k * step, g, czg + t1];
          const mid = (t0 + t1) / 2;
          const dd = Math.hypot(mid, k * step) / ext;
          if (dd >= 1) continue;
          const c = clipSeg(toCam(F, A), toCam(F, B), F.near);
          if (!c) continue;
          const p = camProj(F, c[0]), q = camProj(F, c[1]);
          ctx.strokeStyle = `rgba(236,226,210,${(major ? 0.2 : 0.085) * Math.pow(1 - dd, 1.4)})`;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
        }
      }
    }
  }

  // ---- 地面阴影 ----
  const worldItems = sd.items.filter((it) => it.anchor === "world" && !o.items.get(it.id)?.hidden);
  if (o.shadows) {
    const key = lgOn ? [...wl].filter((l) => l.L[1] < -0.08 && l.role !== "bg").sort((a, b) => b.intensity - a.intensity)[0] : DISPLAY_WL[0];
    for (const it of worldItems) {
      const hgt = Math.max(...it.pts.map((p) => p[1])) - Math.min(...it.pts.map((p) => p[1]));
      const bottom = Math.max(...it.pts.map((p) => p[1]));
      if (bottom < g - hgt * 0.6 - sd.meter * 0.5) continue; // 悬空太高的不投影
      const pts2: { x: number; z: number }[] = [];
      for (const P of it.pts) {
        if (key) {
          const dy = -key.L[1];
          const s = Math.min((g - P[1]) / Math.max(0.12, dy), hgt * 3.5);
          pts2.push({ x: P[0] - key.L[0] * s, z: P[2] - key.L[2] * s });
        } else pts2.push({ x: P[0], z: P[2] });
      }
      const hl = hull(pts2);
      const poly = screenPoly(F, hl.map((p) => [p.x, g, p.z] as V3));
      if (!poly) continue;
      ctx.fillStyle = `rgba(8,6,4,${key ? 0.28 * Math.min(1, key.intensity + 0.2) : 0.22})`;
      ctx.beginPath();
      poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
    }
  }

  // ---- 体块（画家算法） ----
  type Face = { id: string; poly: { x: number; y: number }[]; depth: number; fill: string; stroke: string; width: number; dash: boolean; kind: "world" | "backdrop" };
  const faces: Face[] = [];
  for (const it of sd.items) {
    const di = o.items.get(it.id);
    if (!di || di.hidden || it.anchor === "screen") continue;
    const sel = o.selection.has(it.id), hov = o.hover === it.id;
    const base = mixRgb(hexRgb(di.color), [0.86, 0.84, 0.8], 0.42);
    if (it.anchor === "backdrop") {
      const f = CUBE_FACES[0];
      const poly = screenPoly(F, f.map((k) => it.pts[k]));
      if (!poly) continue;
      const c = backdropShade(mixRgb(hexRgb(di.color), [0.8, 0.8, 0.8], 0.5), wl, lg);
      const dep = toCam(F, it.center)[2];
      faces.push({ id: it.id, poly, depth: dep, fill: rgba(c, sel ? 0.34 : 0.2), stroke: rgba(hexRgb(di.color), sel ? 0.95 : hov ? 0.75 : 0.45), width: sel ? 2 : 1, dash: true, kind: "backdrop" });
      continue;
    }
    const flat = len(sub(it.pts[0], it.pts[4])) < 1e-6;
    const list = flat ? [CUBE_FACES[0]] : CUBE_FACES;
    for (const f of list) {
      const pts = f.map((k) => it.pts[k]);
      const fc = mul(pts.reduce((a, b) => add(a, b), [0, 0, 0] as V3), 0.25);
      let n = faceNormal(it.pts, f, it.center);
      if (flat) n = dot(n, sub(F.eye, fc)) < 0 ? mul(n, -1) : n;
      else if (dot(n, sub(F.eye, fc)) <= 0) continue;
      const poly = screenPoly(F, pts);
      if (!poly) continue;
      const c = shade(n, base, wl, lg);
      const dep = Math.max(...pts.map((P) => toCam(F, P)[2])) * 0.5 + toCam(F, fc)[2] * 0.5;
      const col = hexRgb(di.color);
      faces.push({
        id: it.id, poly, depth: dep, fill: rgba(mixRgb(c, [1, 1, 1], hov && !sel ? 0.08 : 0), 0.94),
        stroke: sel ? "rgba(255,255,255,0.95)" : rgba(mixRgb(col, [1, 1, 1], 0.25), hov ? 1 : 0.85), width: sel ? 1.8 : 1.1, dash: false, kind: "world",
      });
    }
  }
  faces.sort((a, b) => b.depth - a.depth);
  const hitItems: HitMap["items"] = [];
  ctx.lineJoin = "round";
  for (const f of faces) {
    ctx.beginPath();
    f.poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = f.fill;
    ctx.fill();
    ctx.setLineDash(f.dash ? [6, 4] : []);
    ctx.strokeStyle = f.stroke;
    ctx.lineWidth = f.width;
    ctx.stroke();
    hitItems.push({ id: f.id, poly: f.poly });
  }
  ctx.setLineDash([]);

  // ---- 拍摄镜头：视锥 + 画框 ----
  const fr = sd.frame;
  const orange = "#f0a04b";
  const quad = [[0, 0], [fr.W, 0], [fr.W, fr.H], [0, fr.H]].map(([u, v]) => framePt(fr, u, v, sd.planeDepth));
  const camHit = drawCamera(ctx, F, fr, quad, orange, 1, false);
  // 贴屏框画在画框上
  for (const it of sd.items) {
    const di = o.items.get(it.id);
    if (!di || di.hidden || it.anchor !== "screen") continue;
    const poly = screenPoly(F, it.pts);
    if (!poly) continue;
    ctx.beginPath();
    poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = rgba(hexRgb(di.color), o.selection.has(it.id) ? 0.35 : 0.18);
    ctx.fill();
    ctx.strokeStyle = o.selection.has(it.id) ? "#fff" : di.color;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    hitItems.push({ id: it.id, poly });
  }
  if (o.moved) {
    const b = sd.base;
    const q0 = [[0, 0], [b.W, 0], [b.W, b.H], [0, b.H]].map(([u, v]) => framePt(b, u, v, sd.planeDepth * 0.22));
    drawCamera(ctx, F, b, q0, "rgba(230,222,210,0.55)", 0.8, true);
  }

  // ---- 层号徽标 ----
  ctx.font = "600 11px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const it of worldItems) {
    const di = o.items.get(it.id)!;
    const top = Math.min(...it.pts.map((p) => p[1]));
    const p = projectPt(F, [it.center[0], top, it.center[2]]);
    if (!p || p.x < -30 || p.y < -30 || p.x > W + 30 || p.y > H + 30) continue;
    const sel = o.selection.has(it.id), hov = o.hover === it.id;
    const label = String(di.index + 1);
    ctx.fillStyle = sel ? "#ffffff" : di.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y - 12, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = sel ? di.color : "#fff";
    ctx.fillText(label, p.x, p.y - 11.5);
    if (sel || hov) {
      const tw = ctx.measureText(di.name).width + 12;
      ctx.fillStyle = "rgba(24,22,20,0.82)";
      roundRect(ctx, p.x - tw / 2, p.y - 40, tw, 18, 5);
      ctx.fill();
      ctx.fillStyle = "#f4efe8";
      ctx.fillText(di.name, p.x, p.y - 30.5);
    }
  }

  // ---- 灯 ----
  const { S, R } = lightAnchor(sd);
  const lightsHit: HitMap["lights"] = [];
  if (o.showLights && o.lighting?.enabled) {
    const Sp = projectPt(F, S);
    for (const l of o.lighting.lights) {
      const P = add(S, mul(lightVec(worldAzimuth(l, o.lighting, o.cam), l.elevation), R));
      const p = projectPt(F, P);
      if (!p) continue;
      const rgb = l.kelvin !== null ? hexRgbK(l.kelvin) : hexRgb(l.color);
      const act = o.activeLight === l.id;
      const off = !l.enabled;
      if (Sp) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = rgba(rgb, off ? 0.18 : 0.55);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(Sp.x, Sp.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const r = Math.max(7, Math.min(13, (F.f * R * 0.07) / p.z));
      if (!off) {
        const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.6);
        glow.addColorStop(0, rgba(rgb, 0.55 * Math.min(1, l.intensity + 0.2)));
        glow.addColorStop(1, rgba(rgb, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = off ? "rgba(60,56,50,0.9)" : rgbHex(rgb);
      ctx.strokeStyle = act ? "#ffffff" : "rgba(20,18,16,0.85)";
      ctx.lineWidth = act ? 2.2 : 1.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = off ? "#bbb" : lum(rgb) > 0.6 ? "#2a2520" : "#fff";
      ctx.font = "700 10px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(ROLES[l.role].short, p.x, p.y + 0.5);
      lightsHit.push({ id: l.id, x: p.x, y: p.y });
    }
  }
  return { items: hitItems, camera: camHit, lights: lightsHit, lightCenter: S, lightRadius: R };
}

function drawCamera(ctx: CanvasRenderingContext2D, F: ObsFrame, fr: SceneFrame, quad: V3[], color: string, alpha: number, dashed: boolean): { x: number; y: number } | null {
  const Cc = toCam(F, fr.C);
  ctx.setLineDash(dashed ? [5, 4] : []);
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1.1;
  for (const P of quad) {
    const c = clipSeg(Cc, toCam(F, P), F.near);
    if (!c) continue;
    const a = camProj(F, c[0]), b = camProj(F, c[1]);
    ctx.globalAlpha = alpha * 0.7;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = alpha;
  const poly = screenPoly(F, quad);
  if (poly) {
    ctx.beginPath();
    poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    if (!dashed) {
      ctx.fillStyle = "rgba(240,160,75,0.07)";
      ctx.fill();
    }
    ctx.lineWidth = dashed ? 1 : 1.8;
    ctx.stroke();
    // 上沿的小三角：画面的「上」
    if (!dashed) {
      const mid: V3 = mul(add(quad[0], quad[1]), 0.5);
      const up = mul(fr.down, -len(sub(quad[0], quad[3])) * 0.07);
      const w = mul(sub(quad[1], quad[0]), 0.05);
      const tri = screenPoly(F, [sub(mid, w), add(mid, w), add(mid, up)]);
      if (tri) {
        ctx.beginPath();
        tri.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
  }
  ctx.setLineDash([]);
  let hit: { x: number; y: number } | null = null;
  if (Cc[2] >= F.near) {
    const p = camProj(F, Cc);
    ctx.beginPath();
    ctx.arc(p.x, p.y, dashed ? 4 : 7, 0, Math.PI * 2);
    ctx.fillStyle = dashed ? "rgba(230,222,210,0.6)" : color;
    ctx.fill();
    if (!dashed) {
      ctx.strokeStyle = "rgba(30,24,18,0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "rgba(250,236,214,0.95)";
      ctx.textAlign = "left";
      ctx.fillText("镜头", p.x + 11, p.y + 1);
      ctx.textAlign = "center";
    } else {
      ctx.font = "500 10px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "rgba(230,222,210,0.7)";
      ctx.textAlign = "left";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText("初始", p.x, p.y + 7);
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "center";
    }
    hit = p;
  }
  ctx.globalAlpha = 1;
  return hit;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

/** 网格间距：约 1 米，取 1 / 2 / 5 倍数 */
function niceStep(meter: number): number {
  const target = meter;
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5, 10]) if (p * m >= target * 0.8) return p * m;
  return p * 10;
}

const hexRgbK = (k: number) => kelvinRgb(k);
