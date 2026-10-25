/**
 * 摄像机：把每个框看成场景里的 3D 体块（远近 z、厚度、朝向），按机位投影回画面。
 * 坐标：x 向右、y 向下、z 朝画面里。初始机位在原点看 +z，竖直视角 50°。
 * 非破坏：原框 = 初始机位下的投影；任意机位的结果经过“身份映射”，保证回到初始机位时框不变。
 */
import type { Anchor, BBox, Body, Camera, CameraKey, LayoutDraft, LayoutItem } from "../types";
import { clampBBox, defaultCamera } from "./doc";

export const BASE_FOV = 50;
export const CAMERA_LIMITS: Record<CameraKey, [number, number]> = {
  orbit: [-180, 180], pitch: [-85, 85], roll: [-60, 60], distance: [0.2, 5], fov: [10, 120],
  pan_x: [-3, 3], pan_y: [-3, 3], pan_z: [-0.9, 3],
};
export const CAMERA_KEYS = Object.keys(CAMERA_LIMITS) as CameraKey[];

type V3 = [number, number, number];
const rad = (d: number) => (d * Math.PI) / 180;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export function clampCamera(c: Partial<Camera>): Camera {
  const out = { ...defaultCamera(), ...c } as Camera;
  for (const k of CAMERA_KEYS) {
    const [lo, hi] = CAMERA_LIMITS[k];
    const v = Number(out[k]);
    out[k] = Number.isFinite(v) ? clamp(k === "orbit" ? wrapDeg(v) : v, lo, hi) : defaultCamera()[k];
  }
  return out;
}

export function isBaseCamera(c?: Camera | null): boolean {
  if (!c) return true;
  const d = defaultCamera();
  return CAMERA_KEYS.every((k) => Math.abs((c[k] ?? d[k]) - d[k]) < 1e-3);
}

export const cameraActive = (d: LayoutDraft) => !!d.camera?.enabled;
/** 摄像机开着且不在初始机位：画面上显示投影结果，框不能直接拖 */
export const cameraMoved = (d: LayoutDraft) => !!d.camera?.enabled && !isBaseCamera(d.camera);

/** 构图大小：1 = 和初始机位一样；<1 推近；>1 拉远 */
export function framingZoom(c: Camera) {
  return (c.distance * Math.tan(rad(c.fov) / 2)) / Math.tan(rad(BASE_FOV) / 2);
}

// ---------- 体块估算 ----------
const BACKDROP_WORDS = /(sky|background|backdrop|landscape|scenery|wall|horizon|skyline|mountains?|clouds?|ocean|sea|天空|晚霞|云|背景|远景|远处|远山|群山|风景|墙|天际|楼群|海面|大海)/i;

/**
 * 手持物 / 贴身道具：和某个更大的框有重叠的物体，深度跟着它（否则按地平线估，枪、包之类会被当成远处的东西）。
 * 成组的框优先找同组里更大的成员（人物、物体都算）；不在组里的物体找重叠的人物。
 */
function holderOf(it: LayoutItem, items: LayoutItem[], isWorld: (c: LayoutItem) => boolean): LayoutItem | null {
  const area = (b: BBox) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const a = Math.max(1, area(it.bbox));
  const pick = (ok: (c: LayoutItem) => boolean) => {
    let best: LayoutItem | null = null;
    let bestR = 0;
    for (const c of items) {
      if (c.id === it.id || c.hidden || area(c.bbox) <= a || !ok(c)) continue;
      const ix = Math.min(it.bbox[2], c.bbox[2]) - Math.max(it.bbox[0], c.bbox[0]);
      const iy = Math.min(it.bbox[3], c.bbox[3]) - Math.max(it.bbox[1], c.bbox[1]);
      const r = ix > 0 && iy > 0 ? (ix * iy) / a : 0;
      if (r > bestR) { bestR = r; best = c; }
    }
    return bestR >= 0.1 ? best : null;
  };
  if (it.group) {
    const g = pick((c) => c.group === it.group && c.label !== "text" && isWorld(c));
    if (g) return g;
  }
  return it.label === "object" ? pick((c) => c.label === "character" && isWorld(c)) : null;
}

/** 挂在 holder 身上的框：图层在它上面就略靠前，在下面就略靠后 */
const attachedZ = (hz: number, front: boolean) => Math.round(clamp(hz * (front ? 0.97 : 1.03), 0.15, 12) * 1e4) / 1e4;

/**
 * 估算体块。传入 items 时会识别“拿在角色手里 / 挨着角色 / 同组”的框，让它和对方同一深度、略靠前（或靠后）。
 * zOf：对方的深度从哪来（默认用对方已有的体块，没有就现估）。
 */
export function estimateBody(it: LayoutItem, W: number, H: number, horizonY?: number, items?: LayoutItem[], zOf?: (c: LayoutItem) => number): Body {
  const own = estimateBodyAlone(it, W, H, horizonY);
  if (!items || own.anchor !== "world" || (it.label !== "object" && !it.group)) return own;
  const h = holderOf(it, items, (c) => (c.body?.anchor ?? estimateBodyAlone(c, W, H, horizonY).anchor) === "world");
  if (!h) return own;
  const cz = zOf ? zOf(h) : h.body?.z ?? estimateBodyAlone(h, W, H, horizonY).z;
  const front = items.indexOf(it) > items.indexOf(h);
  return { ...own, z: Math.round(attachedZ(cz, front) * 100) / 100 };
}

function estimateBodyAlone(it: LayoutItem, W: number, H: number, horizonY?: number): Body {
  const [x1, y1, x2, y2] = it.bbox;
  const bw = x2 - x1;
  const bh = y2 - y1;
  if (it.label === "text") return { z: 1, thickness: 0.05, yaw: 0, anchor: "screen" };
  const cover = (bw * bh) / (W * H);
  const words = BACKDROP_WORDS.test(it.caption + " " + (it.name || ""));
  const wide = bw >= W * 0.85;
  if ((bw >= W * 0.9 && bh >= H * 0.6) || (cover > 0.5 && words) || (wide && (it.depth === "bg" || (words && cover > 0.15))))
    return { z: 6, thickness: 0, yaw: 0, anchor: "backdrop" };
  const hy = horizonY ?? H * 0.45;
  let z: number;
  if (y2 > hy + H * 0.05) {
    // 站在地面上：底边越接近地平线越远
    z = (H - hy) / (y2 - hy);
  } else {
    // 悬空 / 天上的东西：按大小估
    z = Math.sqrt((0.18 * W * H) / Math.max(1, bw * bh));
  }
  z = clamp(z, 0.4, 8);
  const flat = bw > bh * 3 || bh > bw * 4;
  const thickness = it.label === "character" ? 0.45 : flat ? 0.12 : 0.6;
  return { z: Math.round(z * 100) / 100, thickness, yaw: 0, anchor: "world" };
}

const horizonOf = (d: LayoutDraft) => (d.perspective?.enabled ? d.perspective.horizon_y : undefined);

export function bodyOf(it: LayoutItem, d: LayoutDraft): Body {
  if (it.body) return it.body;
  return estimateBody(it, d.width, d.height, horizonOf(d), d.items);
}

export function estimateBodies(d: LayoutDraft, onlyMissing = false): LayoutDraft {
  const hz = horizonOf(d);
  // 先定角色，再让手持物跟随（全部重估时角色也用新估的深度）
  const charZ = (c: LayoutItem) => (onlyMissing && c.body ? c.body.z : estimateBodyAlone(c, d.width, d.height, hz).z);
  return {
    ...d,
    items: d.items.map((it) =>
      onlyMissing && it.body ? it : { ...it, body: estimateBody(it, d.width, d.height, hz, d.items, charZ) }),
  };
}

// ---------- 投影 ----------
interface Frame {
  C: V3;
  right: V3;
  down: V3;
  fwd: V3;
  f: number;
  W: number;
  H: number;
  near: number;
}

export const f0 = (H: number) => H / 2 / Math.tan(rad(BASE_FOV) / 2);

/** 主体：最大的人物框，没有人物就取最大的 3D 体块 */
export function subjectItem(d: LayoutDraft): LayoutItem | null {
  const world = d.items.filter((it) => !it.hidden && bodyOf(it, d).anchor === "world");
  const chars = world.filter((it) => it.label === "character");
  const pool = chars.length ? chars : world;
  if (!pool.length) return null;
  const area = (b: BBox) => (b[2] - b[0]) * (b[3] - b[1]);
  return pool.reduce((a, b) => (area(b.bbox) > area(a.bbox) ? b : a));
}

function subjectZ(d: LayoutDraft): number {
  const s = subjectItem(d);
  return s ? bodyOf(s, d).z : 1;
}

function makeFrame(c: Camera, W: number, H: number, pivotZ: number): Frame {
  const F0 = f0(H);
  const D0 = F0 * pivotZ;
  const T: V3 = [0, 0, D0];
  const o = rad(c.orbit);
  const p = rad(c.pitch);
  const dir: V3 = [Math.sin(o) * Math.cos(p), -Math.sin(p), -Math.cos(o) * Math.cos(p)];
  const fwd = mul(dir, -1);
  let right = norm(cross(fwd, [0, -1, 0]));
  let down = cross(fwd, right);
  const r = rad(c.roll);
  const r2: V3 = add(mul(right, Math.cos(r)), mul(down, Math.sin(r)));
  const d2: V3 = sub(mul(down, Math.cos(r)), mul(right, Math.sin(r)));
  right = r2;
  down = d2;
  const pan = add(add(mul(right, c.pan_x * D0), mul(down, c.pan_y * D0)), mul(fwd, -c.pan_z * D0));
  const C = add(add(T, mul(dir, D0 * c.distance)), pan);
  return { C, right, down, fwd, f: H / 2 / Math.tan(rad(c.fov) / 2), W, H, near: D0 * 0.02 };
}

function project(fr: Frame, P: V3): { u: number; v: number; zc: number } | null {
  const r = sub(P, fr.C);
  const zc = dot(r, fr.fwd);
  if (zc < fr.near) return null;
  return { u: fr.W / 2 + (fr.f * dot(r, fr.right)) / zc, v: fr.H / 2 + (fr.f * dot(r, fr.down)) / zc, zc };
}

/** 体块 8 个角点（世界坐标）。顺序：前面 0-3（左上、右上、右下、左下），后面 4-7 */
function cubeCorners(it: LayoutItem, b: Body, W: number, H: number): { pts: V3[]; center: V3 } {
  const F0 = f0(H);
  const [x1, y1, x2, y2] = it.bbox;
  const z = b.z;
  const X1 = (x1 - W / 2) * z;
  const X2 = (x2 - W / 2) * z;
  const Y1 = (y1 - H / 2) * z;
  const Y2 = (y2 - H / 2) * z;
  const Zf = z * F0;
  const depth = Math.max(0, b.thickness) * (X2 - X1);
  const cx = (X1 + X2) / 2;
  const cz = Zf + depth / 2;
  const yaw = rad(b.yaw);
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const rot = (x: number, y: number, zz: number): V3 => {
    const dx = x - cx;
    const dz = zz - cz;
    return [cx + dx * cs - dz * sn, y, cz + dx * sn + dz * cs];
  };
  const face = (zz: number): V3[] => [rot(X1, Y1, zz), rot(X2, Y1, zz), rot(X2, Y2, zz), rot(X1, Y2, zz)];
  return { pts: [...face(Zf), ...face(Zf + depth)], center: [cx, (Y1 + Y2) / 2, cz] };
}

export const CUBE_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
];

export interface ProjectedItem {
  id: string;
  anchor: Anchor;
  /** 投影后的框（未裁剪，可能出画） */
  raw: BBox;
  /** 裁到画布内的框（编译用） */
  bbox: BBox;
  visible: boolean;
  partial: boolean;
  /** 8 个角点（画布坐标，null=在镜头后面），用于线框 */
  corners: ({ x: number; y: number } | null)[] | null;
  depth: number;
}

export interface Projection {
  items: Record<string, ProjectedItem>;
  order: string[];
  horizon: { a: { x: number; y: number }; b: { x: number; y: number } } | null;
  vp: { x: number; y: number } | null;
}

function bboxOf(pts: { u: number; v: number }[]): BBox {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of pts) {
    x1 = Math.min(x1, p.u); y1 = Math.min(y1, p.v); x2 = Math.max(x2, p.u); y2 = Math.max(y2, p.v);
  }
  return [x1, y1, x2, y2];
}

/** 单个 3D 体块在机位 fr 下的投影（fb = 初始机位，用来把投影对齐回原框） */
function projectWorldItem(it: LayoutItem, b: Body, W: number, H: number, fr: Frame, fb: Frame): { item: ProjectedItem; camDepth: number; baseDepth: number; cpt?: { x: number; y: number } | null } {
  const { pts, center } = cubeCorners(it, b, W, H);
  const base = pts.map((P) => project(fb, P)).filter(Boolean) as { u: number; v: number; zc: number }[];
  const cur = pts.map((P) => project(fr, P));
  const curOk = cur.filter(Boolean) as { u: number; v: number; zc: number }[];
  const cb = project(fr, center);
  const cbBase = project(fb, center);
  const camDepth = cb ? cb.zc : -1;
  const baseDepth = cbBase ? cbBase.zc : 1;
  if (!curOk.length || base.length < 8) {
    return { item: { id: it.id, anchor: "world", raw: [...it.bbox] as BBox, bbox: [...it.bbox] as BBox, visible: false, partial: true, corners: null, depth: -1 }, camDepth, baseDepth };
  }
  // 身份映射：初始机位的投影框 → 原框
  const A = bboxOf(base);
  const [ox1, oy1, ox2, oy2] = it.bbox;
  const kx = (ox2 - ox1) / Math.max(1e-6, A[2] - A[0]);
  const ky = (oy2 - oy1) / Math.max(1e-6, A[3] - A[1]);
  const acx = (A[0] + A[2]) / 2, acy = (A[1] + A[3]) / 2;
  const ocx = (ox1 + ox2) / 2, ocy = (oy1 + oy2) / 2;
  const map = (p: { u: number; v: number }) => ({ x: ocx + (p.u - acx) * kx, y: ocy + (p.v - acy) * ky });
  const mapped = cur.map((p) => (p ? map(p) : null));
  const okPts = mapped.filter(Boolean) as { x: number; y: number }[];
  const raw: BBox = [
    Math.min(...okPts.map((p) => p.x)), Math.min(...okPts.map((p) => p.y)),
    Math.max(...okPts.map((p) => p.x)), Math.max(...okPts.map((p) => p.y)),
  ];
  const ix1 = Math.max(0, raw[0]), iy1 = Math.max(0, raw[1]);
  const ix2 = Math.min(W, raw[2]), iy2 = Math.min(H, raw[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const area = Math.max(1, (raw[2] - raw[0]) * (raw[3] - raw[1]));
  const visible = ix2 - ix1 >= 6 && iy2 - iy1 >= 6 && inter / area >= 0.03;
  return {
    item: {
      id: it.id, anchor: "world", raw, visible,
      bbox: visible ? clampBBox([ix1, iy1, ix2, iy2], W, H) : clampBBox(raw, W, H),
      partial: okPts.length < 8 || inter / area < 0.999, corners: mapped, depth: camDepth,
    },
    camDepth, baseDepth,
    // 体块中心点在画面里的位置（部分在镜头后面、外接框算不出来时用它来拖）
    cpt: cb ? map(cb) : null,
  };
}

export function projectLayout(d: LayoutDraft, camIn?: Camera): Projection {
  const cam = clampCamera(camIn || d.camera || defaultCamera());
  const W = d.width;
  const H = d.height;
  const pz = subjectZ(d);
  const fr = makeFrame(cam, W, H, pz);
  const fb = makeFrame(defaultCamera(), W, H, pz);
  const items: Record<string, ProjectedItem> = {};
  const camDepth: Record<string, number> = {};
  const baseDepth: Record<string, number> = {};

  d.items.forEach((it) => {
    const b = bodyOf(it, d);
    if (b.anchor !== "world") {
      items[it.id] = {
        id: it.id, anchor: b.anchor, raw: [...it.bbox] as BBox, bbox: [...it.bbox] as BBox, visible: true,
        partial: false, corners: null, depth: b.anchor === "backdrop" ? Infinity : 0,
      };
      return;
    }
    const r = projectWorldItem(it, b, W, H, fr, fb);
    items[it.id] = r.item;
    camDepth[it.id] = r.camDepth;
    baseDepth[it.id] = r.baseDepth;
  });

  // 图层：保持原顺序，只在“新机位下远近关系明显反转”的相邻对之间交换
  const backdrop = d.items.filter((it) => items[it.id].anchor === "backdrop").map((it) => it.id);
  const screen = d.items.filter((it) => items[it.id].anchor === "screen").map((it) => it.id);
  const world = d.items.filter((it) => items[it.id].anchor === "world").map((it) => it.id);
  const M = 0.12;
  const farther = (a: string, b: string, dd: Record<string, number>) => dd[a] > dd[b] * (1 + M);
  const order = [...world];
  if (!isBaseCamera(cam)) {
    for (let pass = 0; pass < order.length; pass++) {
      let swapped = false;
      for (let k = 0; k < order.length - 1; k++) {
        const a = order[k];
        const b = order[k + 1];
        if (farther(b, a, camDepth) && !farther(b, a, baseDepth)) {
          order[k] = b;
          order[k + 1] = a;
          swapped = true;
        }
      }
      if (!swapped) break;
    }
  }

  // 地平线：与地面平行方向的消失线；纵深消失点：世界 +z 方向
  let horizon: Projection["horizon"] = null;
  let vp: Projection["vp"] = null;
  const dirPt = (v: V3) => {
    const zc = dot(v, fr.fwd);
    if (zc <= 1e-6) return null;
    return { x: W / 2 + (fr.f * dot(v, fr.right)) / zc, y: H / 2 + (fr.f * dot(v, fr.down)) / zc };
  };
  const hdir = norm([fr.fwd[0], 0, fr.fwd[2]]);
  const side = norm(cross([0, -1, 0], hdir));
  const p1 = dirPt(add(hdir, mul(side, 0.6)));
  const p2 = dirPt(sub(hdir, mul(side, 0.6)));
  if (p1 && p2 && Math.abs(cam.pitch) < 80) horizon = { a: p1, b: p2 };
  const z = dirPt([0, 0, 1]);
  if (z && Math.abs(z.x) < W * 4 && Math.abs(z.y) < H * 4) vp = z;

  return { items, order: [...backdrop, ...order, ...screen], horizon, vp };
}

/** 发给编译 / Agent 的视图：摄像机关闭或在初始机位时返回 undefined */
export function compileView(d: LayoutDraft) {
  if (!cameraMoved(d)) return undefined;
  const pr = projectLayout(d);
  const items: Record<string, { bbox: BBox; visible: boolean }> = {};
  for (const [id, p] of Object.entries(pr.items)) items[id] = { bbox: p.bbox.map(Math.round) as BBox, visible: p.visible };
  return { items, order: pr.order };
}

/** 定为基准：把当前机位下的框烘焙回原框，机位归零（出画的框隐藏保留） */
export function rebaseCamera(d: LayoutDraft): LayoutDraft {
  if (!d.camera) return d;
  const cam = clampCamera(d.camera);
  const pr = projectLayout(d, cam);
  const byId = new Map(d.items.map((it) => [it.id, it]));
  const F0 = f0(d.height);
  const items = pr.order.map((id) => {
    const it = byId.get(id)!;
    const p = pr.items[id];
    const b = bodyOf(it, d);
    if (p.anchor !== "world") return it;
    const z = p.depth > 0 ? Math.max(0.15, Math.min(12, p.depth / F0)) : b.z;
    return {
      ...it,
      bbox: p.bbox,
      hidden: it.hidden || !p.visible,
      body: { ...b, yaw: Math.round(wrapDeg(b.yaw - cam.orbit) * 10) / 10, z: Math.round(z * 100) / 100 },
    };
  });
  return { ...d, items, camera: { ...defaultCamera(), enabled: true } };
}

export interface CameraPreset {
  name: string;
  cam: Partial<Camera>;
}

export const CAMERA_PRESETS: CameraPreset[] = [
  { name: "正面平视", cam: {} },
  { name: "略微俯拍", cam: { pitch: 15 } },
  { name: "高机位俯拍", cam: { pitch: 40 } },
  { name: "鸟瞰", cam: { pitch: 78, distance: 1.15 } },
  { name: "低机位仰拍", cam: { pitch: -30 } },
  { name: "左前 45°", cam: { orbit: -45 } },
  { name: "右前 45°", cam: { orbit: 45 } },
  { name: "右侧 90°", cam: { orbit: 90 } },
  { name: "背面", cam: { orbit: 180 } },
  { name: "荷兰角", cam: { roll: 15 } },
  { name: "广角贴近", cam: { fov: 85, distance: 0.55 } },
  { name: "长焦压缩", cam: { fov: 22, distance: 2.4 } },
  { name: "推近特写", cam: { distance: 0.55 } },
];

/** 与后端 camera_phrase 一致的中文镜头语言（界面实时显示用） */
export function cameraPhraseZh(c: Camera, d: LayoutDraft): string {
  const world = d.items.filter((it) => !it.hidden && bodyOf(it, d).anchor === "world");
  const chars = world.filter((it) => it.label === "character");
  const pool = chars.length ? chars : world;
  const area = (b: BBox) => (b[2] - b[0]) * (b[3] - b[1]);
  const subj = pool.length ? pool.reduce((a, b) => (area(b.bbox) > area(a.bbox) ? b : a)) : null;
  const rel = wrapDeg(c.orbit - (subj ? bodyOf(subj, d).yaw : 0));
  const parts: string[] = [];
  const p = c.pitch;
  if (p >= 60) parts.push("鸟瞰");
  else if (p >= 25) parts.push(`高机位俯拍 ${Math.round(p)}°`);
  else if (p >= 8) parts.push("略微俯拍");
  else if (p <= -60) parts.push("虫视仰拍");
  else if (p <= -25) parts.push(`低机位仰拍 ${Math.round(-p)}°`);
  else if (p <= -8) parts.push("略微仰拍");
  const r = Math.abs(rel);
  const side = rel > 0 ? "右" : "左";
  if (r >= 15 && r < 60) parts.push(`${side}前四分之三侧`);
  else if (r >= 60 && r < 120) parts.push(`${side}侧面`);
  else if (r >= 120) parts.push("背面");
  if (Math.abs(c.roll) >= 5) parts.push(`荷兰角 ${Math.round(Math.abs(c.roll))}°`);
  const z = framingZoom(c);
  if (z < 0.45) parts.push("极近特写");
  else if (z < 0.7) parts.push("近景特写");
  else if (z < 0.88) parts.push("推近");
  else if (z > 1.7) parts.push("远景全景");
  else if (z > 1.18) parts.push("拉远");
  if (c.fov >= 85) parts.push("超广角");
  else if (c.fov >= 62) parts.push("广角");
  else if (c.fov <= 24) parts.push("长焦");
  else if (c.fov <= 36) parts.push("中长焦");
  return parts.join(" · ") || "中性平视";
}


// ---------- 镜头调度辅助 ----------

/** 竖直视角 → 35mm 等效焦距（按画面对角线对应 43.27mm 换算） */
export function equivFocal(fov: number, W: number, H: number): number {
  const diag = Math.hypot(W, H) / H;
  return 21.63 / (diag * Math.tan(rad(fov) / 2));
}

/** 一组框在当前机位下的投影外接框（未裁剪）。全部在镜头后面时返回 null */
export function measureItems(d: LayoutDraft, cam: Camera, ids: string[], pr?: Projection): BBox | null {
  const p = pr || projectLayout(d, cam);
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, n = 0;
  for (const id of ids) {
    const it = p.items[id];
    if (!it || it.anchor !== "world" || !it.corners) continue;
    n++;
    x1 = Math.min(x1, it.raw[0]); y1 = Math.min(y1, it.raw[1]); x2 = Math.max(x2, it.raw[2]); y2 = Math.max(y2, it.raw[3]);
  }
  return n ? [x1, y1, x2, y2] : null;
}

/** 原框（初始机位）的外接框 */
export function baseBounds(d: LayoutDraft, ids: string[]): BBox | null {
  const its = d.items.filter((it) => ids.includes(it.id));
  if (!its.length) return null;
  return [
    Math.min(...its.map((i) => i.bbox[0])), Math.min(...its.map((i) => i.bbox[1])),
    Math.max(...its.map((i) => i.bbox[2])), Math.max(...its.map((i) => i.bbox[3])),
  ];
}

export interface FrameGoal {
  /** 目标中心（画布坐标） */
  cx: number;
  cy: number;
  /** 目标大小：sqrt(宽×高)；不给就不约束大小 */
  size?: number;
  /** 收进 w×h 的范围（与 size 二选一） */
  fit?: { w: number; h: number };
}
export type FrameVar = "distance" | "pan_x" | "pan_y";

/**
 * 反解机位：只动 距离 / 平移 X / 平移 Y，让 ids 这组框的投影落到目标位置和大小。
 * 阻尼最小二乘（Levenberg–Marquardt），有限差分求雅可比。环绕、俯仰、滚转、视角保持不变。
 */
export function solveFraming(d: LayoutDraft, camIn: Camera, ids: string[], goal: FrameGoal, vars: FrameVar[] = ["distance", "pan_x", "pan_y"]): Camera {
  const base = clampCamera(camIn);
  const H = d.height;
  const useSize = vars.includes("distance") && (goal.size !== undefined || goal.fit !== undefined);
  const keys = vars.filter((v) => v !== "distance" || useSize);
  if (!keys.length || !ids.length) return base;
  const toCam = (x: number[]): Camera => {
    const c = { ...base };
    keys.forEach((k, i) => {
      if (k === "distance") c.distance = Math.exp(x[i]);
      else c[k] = x[i];
    });
    return clampCamera(c);
  };
  const fromCam = (c: Camera) => keys.map((k) => (k === "distance" ? Math.log(c.distance) : c[k]));
  const resid = (x: number[]): number[] | null => {
    const b = measureItems(d, toCam(x), ids);
    if (!b) return null;
    const bw = Math.max(1e-3, b[2] - b[0]), bh = Math.max(1e-3, b[3] - b[1]);
    const r = [((b[0] + b[2]) / 2 - goal.cx) / H, ((b[1] + b[3]) / 2 - goal.cy) / H];
    if (useSize) {
      if (goal.fit) r.push(Math.log(Math.max(bw / goal.fit.w, bh / goal.fit.h)));
      else r.push(Math.log(Math.sqrt(bw * bh) / Math.max(1, goal.size!)));
    }
    return r;
  };
  const cost = (r: number[] | null) => (r ? r.reduce((a, v) => a + v * v, 0) : Infinity);
  let x = fromCam(base);
  let r = resid(x);
  // 起点在镜头后面：先往后拉开再解
  for (let k = 0; !r && k < 6 && keys.includes("distance"); k++) {
    x = x.map((v, i) => (keys[i] === "distance" ? v + 0.35 : v));
    r = resid(x);
  }
  if (!r) return base;
  let c0 = cost(r);
  let lambda = 1e-3;
  for (let iter = 0; iter < 40 && c0 > 1e-10; iter++) {
    const n = keys.length, m = r.length;
    const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
    let ok = true;
    for (let j = 0; j < n; j++) {
      const h = 1e-4;
      const xp = [...x];
      xp[j] += h;
      let rp = resid(xp);
      let hh = h;
      if (!rp) {
        xp[j] = x[j] - h;
        rp = resid(xp);
        hh = -h;
      }
      if (!rp) { ok = false; break; }
      for (let i = 0; i < m; i++) J[i][j] = (rp[i] - r[i]) / hh;
    }
    if (!ok) break;
    // (JᵀJ + λ·diag) δ = -Jᵀr
    const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const g: number[] = new Array(n).fill(0);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) for (let i = 0; i < m; i++) A[a][b] += J[i][a] * J[i][b];
      for (let i = 0; i < m; i++) g[a] -= J[i][a] * r[i];
    }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const M = A.map((row, a) => row.map((v, b) => (a === b ? v + lambda * (v + 1e-9) : v)));
      const delta = solveLinear(M, g);
      if (!delta) { lambda *= 10; continue; }
      const xn = x.map((v, i) => v + delta[i]);
      // 夹到范围内
      const cn = toCam(xn);
      const xc = fromCam(cn);
      const rn = resid(xc);
      const cc = cost(rn);
      if (cc < c0) {
        x = xc; r = rn!; c0 = cc;
        lambda = Math.max(1e-7, lambda / 3);
        improved = true;
        break;
      }
      lambda *= 4;
    }
    if (!improved) break;
  }
  return toCam(x);
}

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** 当前机位下这组框是否完整在画内（允许 tol 像素误差） */
export function insideFrame(b: BBox | null, W: number, H: number, tol = 1): boolean {
  return !!b && b[0] >= -tol && b[1] >= -tol && b[2] <= W + tol && b[3] <= H + tol;
}

export type AutoFrameMode = "smart" | "fit" | "subject" | "center";

/** 自动取景：返回新的机位（不改环绕 / 俯仰 / 滚转 / 视角） */
export function autoFrame(d: LayoutDraft, cam: Camera, mode: AutoFrameMode, ids?: string[]): Camera {
  const W = d.width, H = d.height;
  const world = d.items.filter((it) => !it.hidden && bodyOf(it, d).anchor === "world").map((it) => it.id);
  const subj = subjectItem(d);
  const target = ids && ids.length ? ids.filter((id) => world.includes(id)) : mode === "smart" || mode === "fit" ? world : subj ? [subj.id] : world;
  if (!target.length) return cam;
  const margin = 0.06;
  const fitGoal: FrameGoal = { cx: W / 2, cy: H / 2, fit: { w: W * (1 - 2 * margin), h: H * (1 - 2 * margin) } };
  if (mode === "fit") return solveFraming(d, cam, target, fitGoal);
  const b0 = baseBounds(d, target)!;
  if (mode === "center") return solveFraming(d, cam, target, { cx: W / 2, cy: H / 2 }, ["pan_x", "pan_y"]);
  // smart / subject：回到原构图中的位置和大小；放不下就居中收进画面
  const goal: FrameGoal = { cx: (b0[0] + b0[2]) / 2, cy: (b0[1] + b0[3]) / 2, size: Math.sqrt((b0[2] - b0[0]) * (b0[3] - b0[1])) };
  const sol = solveFraming(d, cam, target, goal);
  if (mode === "subject") return sol;
  if (insideFrame(measureItems(d, sol, target), W, H, Math.max(W, H) * 0.01)) return sol;
  return solveFraming(d, sol, target, fitGoal);
}

export interface PlanItem {
  id: string;
  poly: { x: number; z: number }[];
  front: [{ x: number; z: number }, { x: number; z: number }];
  center: { x: number; z: number };
}
export interface PlanData {
  items: PlanItem[];
  pivot: { x: number; z: number };
  cam: { x: number; z: number; fx: number; fz: number; half: number; y: number };
  base: { x: number; z: number };
  far: number;
  bounds: [number, number, number, number];
  unit: number;
}

/** 俯视图：世界 x-z 平面上的体块占地、机位、视野楔形 */
export function planView(d: LayoutDraft, camIn?: Camera): PlanData {
  const cam = clampCamera(camIn || d.camera || defaultCamera());
  const W = d.width, H = d.height;
  const pz = subjectZ(d);
  const fr = makeFrame(cam, W, H, pz);
  const D0 = f0(H) * pz;
  const items: PlanItem[] = [];
  let maxZ = D0;
  for (const it of d.items) {
    if (it.hidden) continue;
    const b = bodyOf(it, d);
    if (b.anchor !== "world") continue;
    const { pts, center } = cubeCorners(it, b, W, H);
    const q = [pts[0], pts[1], pts[5], pts[4]].map((P) => ({ x: P[0], z: P[2] }));
    items.push({ id: it.id, poly: q, front: [q[0], q[1]], center: { x: center[0], z: center[2] } });
    maxZ = Math.max(maxZ, ...q.map((p) => p.z));
  }
  const hf = norm([fr.fwd[0], 0, fr.fwd[2]]);
  const half = Math.atan((W / 2) / fr.f);
  const xs = [0, fr.C[0], ...items.flatMap((i) => i.poly.map((p) => p.x))];
  const zs = [0, D0, fr.C[2], ...items.flatMap((i) => i.poly.map((p) => p.z))];
  return {
    items,
    pivot: { x: 0, z: D0 },
    cam: { x: fr.C[0], z: fr.C[2], fx: Math.hypot(fr.fwd[0], fr.fwd[2]) > 1e-3 ? hf[0] : 0, fz: Math.hypot(fr.fwd[0], fr.fwd[2]) > 1e-3 ? hf[2] : 1, half, y: fr.C[1] },
    base: { x: 0, z: 0 },
    far: maxZ * 1.12,
    bounds: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)],
    unit: D0,
  };
}

// ---------- 移动体块（镜头视图 / 俯视图） ----------

export type Vec3 = V3;
/** 自由：每个框（成组的整组）单独动；冻结：所有 3D 体块当成一个整体一起动 */
export type MoveScope = "free" | "frozen";
/** 固定：镜头留在原地；随主体：镜头像架在主体身上，主体动它就跟着平移 */
export type CamHold = "fixed" | "subject";

export interface MoveResult {
  /** 每个框的新值（原框 + 体块），直接合并进 items */
  patches: Record<string, Partial<LayoutItem>>;
  /** 需要同时更新的机位（镜头固定时补偿主体深度变化，随主体时跟着平移） */
  camera?: Camera;
  /** 镜头跟着主体动了 */
  camFollowed?: boolean;
}

const round2 = (b: BBox) => b.map((v) => Math.round(v * 100) / 100) as BBox;
const centerOf = (b: BBox) => ({ x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 });

/** 把框整体在世界里平移 t（原框坐标系：x 右、y 下、z 远，单位同 cubeCorners），返回新的原框和体块 */
function translateWorld(it: LayoutItem, b: Body, W: number, H: number, t: V3): { bbox: BBox; body: Body } | null {
  const F0 = f0(H);
  const [x1, y1, x2, y2] = it.bbox;
  const z = b.z;
  // 先把 z 取整再算框，保证存下来的 z 和框严格对应（近处透视强，z 的小误差也会放大成像素偏差）
  const z2 = Math.round(((z * F0 + t[2]) / F0) * 1e4) / 1e4;
  if (!(z2 > 0.15) || z2 > 20) return null;
  const X1 = (x1 - W / 2) * z + t[0], X2 = (x2 - W / 2) * z + t[0];
  const Y1 = (y1 - H / 2) * z + t[1], Y2 = (y2 - H / 2) * z + t[1];
  return {
    bbox: [X1 / z2 + W / 2, Y1 / z2 + H / 2, X2 / z2 + W / 2, Y2 / z2 + H / 2],
    body: { ...b, z: z2 },
  };
}

/** 机位朝向、视角不变，求让镜头光心落在世界坐标 C 的距离 / 平移（主体深度为 pz 时） */
export function cameraAt(cam: Camera, W: number, H: number, pz: number, C: V3): Camera {
  const c = clampCamera(cam);
  const fr = makeFrame(c, W, H, pz);
  const D0 = f0(H) * pz;
  const V = sub(C, [0, 0, D0]);
  const px = dot(V, fr.right) / D0;
  const py = dot(V, fr.down) / D0;
  const s = -dot(V, fr.fwd) / D0; // = 距离 + 前后平移
  let dist = s - c.pan_z;
  let pzz = c.pan_z;
  const [dlo, dhi] = CAMERA_LIMITS.distance;
  if (dist < dlo || dist > dhi) {
    dist = clamp(dist, dlo, dhi);
    pzz = clamp(s - dist, CAMERA_LIMITS.pan_z[0], CAMERA_LIMITS.pan_z[1]);
  }
  return clampCamera({ ...c, distance: dist, pan_x: px, pan_y: py, pan_z: pzz, enabled: cam.enabled });
}

/** 镜头光心的世界坐标 */
export function cameraCenter(d: LayoutDraft, cam?: Camera): V3 {
  return makeFrame(clampCamera(cam || d.camera || defaultCamera()), d.width, d.height, subjectZ(d)).C;
}

/**
 * 这次移动要带上哪些框。
 * - 自由：选中的框 + 同组的框；
 * - 冻结：抓的是 3D 体块时，所有 3D 体块（含隐藏的）一起动；抓的是文字 / 背景板就只动选中的。
 * 锁定的框不动；组里有锁定的框时整组不动（不让组拆开）。solo = 只动 ids 本身（按住 Alt 组内微调）。
 */
export function moveTargets(d: LayoutDraft, ids: string[], scope: MoveScope, grab?: string, solo = false): { ids: string[]; pinned: number } {
  const byId = new Map(d.items.map((it) => [it.id, it]));
  if (solo) {
    // Alt：只动选中的这几个（组内微调）
    const out = ids.filter((id) => byId.get(id) && !byId.get(id)!.locked);
    return { ids: out, pinned: ids.length - out.length };
  }
  const g = grab ? byId.get(grab) : undefined;
  let pool = ids;
  if (scope === "frozen" && (!g || bodyOf(g, d).anchor === "world")) {
    const world = d.items.filter((it) => bodyOf(it, d).anchor === "world").map((it) => it.id);
    pool = Array.from(new Set([...world, ...ids]));
  }
  const want = new Set(pool);
  const groups = new Set(d.items.filter((x) => want.has(x.id) && x.group).map((x) => x.group!));
  const exp = d.items.filter((x) => want.has(x.id) || (x.group && groups.has(x.group)));
  const lockedGroups = new Set(d.items.filter((it) => it.locked && it.group).map((it) => it.group!));
  const out = exp.filter((it) => !it.locked && !(it.group && lockedGroups.has(it.group))).map((it) => it.id);
  return { ids: out, pinned: exp.length - out.length };
}

function withPatches(d: LayoutDraft, patches: Record<string, Partial<LayoutItem>>): LayoutDraft {
  return { ...d, items: d.items.map((it) => (patches[it.id] ? { ...it, ...patches[it.id] } : it)) };
}

/** 把移动结果应用到布局上（纯函数，测试和多步操作用） */
export function applyMoveResult(d: LayoutDraft, r: MoveResult): LayoutDraft {
  const n = withPatches(d, r.patches);
  return r.camera ? { ...n, camera: r.camera } : n;
}

/**
 * 在世界里把 ids 这组 3D 体块整体平移 T（刚体，组内相对位置不变）。
 * hold = fixed：镜头光心不动（主体深度变了也补偿机位参数，别的框在画面里纹丝不动）；
 * hold = subject：移动的框里有主体时，镜头跟着平移同样的 T。
 */
export function translateItems(d: LayoutDraft, ids: string[], T: V3, hold: CamHold): MoveResult | null {
  const W = d.width, H = d.height;
  const set = new Set(ids);
  const patches: Record<string, Partial<LayoutItem>> = {};
  let n = 0;
  for (const it of d.items) {
    const b = bodyOf(it, d);
    if (b.anchor !== "world") continue;
    if (set.has(it.id)) {
      const nb = translateWorld(it, b, W, H, T);
      if (!nb) return null;
      patches[it.id] = { bbox: round2(nb.bbox), body: nb.body };
      n++;
    } else if (!it.body) {
      // 估算出来的体块先固定下来：别的框一动，它的估算值（比如手持物跟随角色）就会跟着变
      patches[it.id] = { body: b };
    }
  }
  if (!n) return null;
  if (!d.camera) return { patches };
  const cam = clampCamera(d.camera);
  const subj = subjectItem(d);
  const follow = hold === "subject" && !!subj && set.has(subj.id);
  const pz0 = subjectZ(d);
  const pz1 = subjectZ(withPatches(d, patches));
  if (!follow && Math.abs(pz1 - pz0) < 1e-9) return { patches };
  const C0 = makeFrame(cam, W, H, pz0).C;
  const cam1 = cameraAt(d.camera, W, H, pz1, follow ? add(C0, T) : C0);
  if (follow) holdOnScreen(d, patches, ids, cam, pz0, cam1, pz1);
  return { patches, camera: cam1, camFollowed: follow };
}

/**
 * 镜头随主体时，跟着镜头一起平移的框在画面里应该一动不动。
 * 投影里的「身份映射」和框的位置有关，刚体平移后会差几个像素：这里微调原框（远近不变），让当前画面里的投影和移动前完全一样。
 */
function holdOnScreen(d: LayoutDraft, patches: Record<string, Partial<LayoutItem>>, ids: string[], cam0: Camera, pz0: number, cam1: Camera, pz1: number) {
  const W = d.width, H = d.height;
  const fr0 = makeFrame(clampCamera(cam0), W, H, pz0), fb0 = makeFrame(defaultCamera(), W, H, pz0);
  const fr1 = makeFrame(clampCamera(cam1), W, H, pz1), fb1 = makeFrame(defaultCamera(), W, H, pz1);
  const full = (r: ReturnType<typeof projectWorldItem>) => (r.item.corners && r.item.corners.every(Boolean) ? r.item.raw : null);
  for (const it of d.items) {
    const p = patches[it.id];
    if (!ids.includes(it.id) || !p?.bbox || !p.body) continue;
    const target = full(projectWorldItem(it, bodyOf(it, d), W, H, fr0, fb0));
    if (!target) continue;
    const body = p.body as Body;
    const f = (bb: BBox) => (bb[2] - bb[0] > 1 && bb[3] - bb[1] > 1 ? full(projectWorldItem({ ...it, bbox: bb }, body, W, H, fr1, fb1)) : null);
    const err = (r: BBox | null) => (r ? Math.max(...r.map((v, i) => Math.abs(v - target[i]))) : Infinity);
    let bb = [...p.bbox] as BBox;
    let cur = f(bb), e0 = err(cur);
    const start = e0;
    for (let k = 0; k < 8 && cur && e0 > 0.02; k++) {
      // 数值雅可比（4×4），高斯消元求一步，回溯保证误差下降
      const J: number[][] = [[], [], [], []];
      let ok = true;
      for (let j = 0; j < 4 && ok; j++) {
        const h = 0.5;
        const b2 = [...bb] as BBox; b2[j] += h;
        const r = f(b2);
        if (!r) { ok = false; break; }
        for (let i = 0; i < 4; i++) J[i][j] = (r[i] - cur[i]) / h;
      }
      if (!ok) break;
      const step = solve4(J, cur.map((v, i) => target[i] - v));
      if (!step) break;
      let lam = 1, moved = false;
      for (let t = 0; t < 6; t++, lam /= 2) {
        const nb = bb.map((v, i) => v + step[i] * lam) as BBox;
        const r = f(nb), e = err(r);
        if (e < e0) { bb = nb; cur = r; e0 = e; moved = true; break; }
      }
      if (!moved) break;
    }
    if (e0 < start) p.bbox = round2(bb);
  }
}

function solve4(A: number[][], b: number[]): number[] | null {
  const n = 4;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-9) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/**
 * 求世界平移 T（在当前镜头的画面平行面里），让框 g 在画面里移动 (dx, dy)。镜头视为不动。
 * 完整在镜头前时对齐投影框中心；部分在镜头后面时对齐体块中心点。
 */
function solveDrag(base: LayoutDraft, g: LayoutItem, dx: number, dy: number): V3 | null {
  const W = base.width, H = base.height;
  const cam = clampCamera(base.camera || defaultCamera());
  const pz = subjectZ(base);
  const fr = makeFrame(cam, W, H, pz);
  const fb = makeFrame(defaultCamera(), W, H, pz);
  const b0 = bodyOf(g, base);
  const p0 = projectWorldItem(g, b0, W, H, fr, fb);
  if (p0.camDepth <= fr.near) return null;
  const full = !!p0.item.corners && p0.item.corners.every(Boolean);
  const anchor = (it: LayoutItem, b: Body) => {
    const r = projectWorldItem(it, b, W, H, fr, fb);
    if (full) return r.item.corners && r.item.corners.every(Boolean) ? centerOf(r.item.raw) : null;
    return r.camDepth > fr.near && r.cpt ? r.cpt : null;
  };
  const a0 = anchor(g, b0);
  if (!a0) return null;
  const target = { x: a0.x + dx, y: a0.y + dy };
  const at = (a: number, b: number): V3 => add(mul(fr.right, a), mul(fr.down, b));
  const evalAt = (a: number, b: number) => {
    const nb = translateWorld(g, b0, W, H, at(a, b));
    if (!nb) return null;
    const c = anchor({ ...g, bbox: nb.bbox }, nb.body);
    return c ? { c } : null;
  };
  // 初值：画面平行面里平移，中心点的镜头深度不变，像素位移 × 深度 / 焦距
  let a = (dx * p0.camDepth) / fr.f, b = (dy * p0.camDepth) / fr.f;
  let cur = evalAt(a, b);
  if (!cur) { a = 0; b = 0; cur = evalAt(0, 0); }
  if (!cur) return null;
  const err = (e: { c: { x: number; y: number } } | null) => (e ? Math.hypot(target.x - e.c.x, target.y - e.c.y) : Infinity);
  const h = Math.max(0.5, b0.z);
  const cap = 3 * Math.max(g.bbox[2] - g.bbox[0], g.bbox[3] - g.bbox[1], 32) * b0.z;
  for (let k = 0; k < 10; k++) {
    const rx = target.x - cur.c.x, ry = target.y - cur.c.y;
    const r0 = Math.hypot(rx, ry);
    if (r0 < 0.25) break;
    const ea = evalAt(a + h, b), eb = evalAt(a, b + h);
    if (!ea || !eb) break;
    const j11 = (ea.c.x - cur.c.x) / h, j21 = (ea.c.y - cur.c.y) / h;
    const j12 = (eb.c.x - cur.c.x) / h, j22 = (eb.c.y - cur.c.y) / h;
    const lam = 1e-3 * (j11 * j11 + j12 * j12 + j21 * j21 + j22 * j22 + 1e-9);
    const A11 = j11 * j11 + j21 * j21 + lam, A12 = j11 * j12 + j21 * j22, A22 = j12 * j12 + j22 * j22 + lam;
    const g1 = j11 * rx + j21 * ry, g2 = j12 * rx + j22 * ry;
    const det = A11 * A22 - A12 * A12;
    if (Math.abs(det) < 1e-12) break;
    let da = (A22 * g1 - A12 * g2) / det, db = (A11 * g2 - A12 * g1) / det;
    const m = Math.hypot(da, db);
    if (m > cap) { da *= cap / m; db *= cap / m; }
    // 回溯线搜索：外接框随角点切换不是处处光滑，只接受让误差变小的步子，拖动时才不会来回跳
    let next = evalAt(a + da, b + db);
    let tries = 0;
    while (err(next) >= r0 && tries++ < 6) { da /= 2; db /= 2; next = evalAt(a + da, b + db); }
    if (!next || err(next) >= r0) break;
    a += da; b += db; cur = next;
  }
  return at(a, b);
}

/**
 * 镜头视图里拖动：抓住的框 grab 在画面里移动 (dx, dy)，ids 这组框跟着做同样的世界平移（刚体，不分离）。
 * 文字 / 背景板这类贴在画面上的框直接平移原框。base 是拖动开始时的布局。
 */
export function dragInView(base: LayoutDraft, grab: string, ids: string[], dx: number, dy: number, hold: CamHold): MoveResult | null {
  const byId = new Map(base.items.map((it) => [it.id, it]));
  const flat: Record<string, Partial<LayoutItem>> = {};
  const world: string[] = [];
  for (const id of ids) {
    const it = byId.get(id);
    if (!it) continue;
    if (bodyOf(it, base).anchor === "world") world.push(id);
    else {
      const [x1, y1, x2, y2] = it.bbox;
      flat[id] = { bbox: [x1 + dx, y1 + dy, x2 + dx, y2 + dy] };
    }
  }
  if (!world.length) return Object.keys(flat).length ? { patches: flat } : null;
  const g = byId.get(world.includes(grab) ? grab : world[0])!;
  const T = solveDrag(base, g, dx, dy);
  if (!T) return Object.keys(flat).length ? { patches: flat } : null;
  const r = translateItems(base, world, T, hold);
  if (!r) return Object.keys(flat).length ? { patches: flat } : null;
  return { ...r, patches: { ...r.patches, ...flat } };
}

/** 俯视图里拖动：在地面（世界 x-z 平面）上平移 */
export function dragOnPlan(base: LayoutDraft, ids: string[], dX: number, dZ: number, hold: CamHold): MoveResult | null {
  return translateItems(base, ids, [dX, 0, dZ], hold);
}

/**
 * 拉回画面：镜头不动，把框（连同 ids 里的同组框）挪进当前画面。
 * 能投影的就平移到最近的完整入画位置；在镜头后面的先搬到镜头正前方（主体那么远）。
 */
export function bringIntoView(d: LayoutDraft, id: string, ids: string[]): MoveResult | null {
  const W = d.width, H = d.height;
  const it = d.items.find((x) => x.id === id);
  if (!it) return null;
  const b = bodyOf(it, d);
  if (b.anchor !== "world") return null;
  const cam = clampCamera(d.camera || defaultCamera());
  const pz = subjectZ(d);
  const fr = makeFrame(cam, W, H, pz);
  const fb = makeFrame(defaultCamera(), W, H, pz);
  const fitPass = (lay: LayoutDraft): MoveResult | null => {
    const cur = lay.items.find((x) => x.id === id)!;
    const p = projectWorldItem(cur, bodyOf(cur, lay), W, H, fr, fb).item;
    if (!p.corners || p.corners.some((c) => !c)) return null;
    const m = Math.min(W, H) * 0.04;
    const w = p.raw[2] - p.raw[0], h = p.raw[3] - p.raw[1];
    const c = centerOf(p.raw);
    const tx = w > W - 2 * m ? W / 2 : clamp(c.x, w / 2 + m, W - w / 2 - m);
    const ty = h > H - 2 * m ? H / 2 : clamp(c.y, h / 2 + m, H - h / 2 - m);
    if (Math.hypot(tx - c.x, ty - c.y) < 0.5) return { patches: {} };
    return dragInView(lay, id, ids, tx - c.x, ty - c.y, "fixed");
  };
  let out: MoveResult = { patches: {} };
  let lay = d;
  let r = fitPass(lay);
  if (!r) {
    // 在镜头后面或穿过镜头：搬到镜头正前方，深度取主体的镜头深度
    const D0 = f0(H) * pz;
    const pivotDepth = dot(sub([0, 0, D0], fr.C), fr.fwd);
    const { center } = cubeCorners(it, b, W, H);
    const target = add(fr.C, mul(fr.fwd, Math.max(pivotDepth, D0 * 0.5)));
    const t0 = sub(target, center);
    const r0 = translateItems(lay, ids, t0, "fixed");
    if (!r0) return null;
    out = r0;
    lay = applyMoveResult(lay, r0);
    r = fitPass(lay);
  }
  for (let k = 0; r && k < 2; k++) {
    // 透视下挪动会改变框的大小，多走一两步收准
    out = { patches: { ...out.patches, ...r.patches }, camera: r.camera ?? out.camera };
    lay = applyMoveResult(lay, r);
    r = fitPass(lay);
    if (r && !Object.keys(r.patches).length) break;
  }
  return Object.keys(out.patches).length ? out : null;
}

/**
 * 成组时对齐远近：和组里更大的成员重叠（手持物、贴身道具）的框，深度对齐到它（图层在上略靠前，在下略靠后）。
 * 只改远近 z、不改原框，所以初始机位下画面不变；转动机位时它们就不会因为深度不一致而分开。
 */
export function alignGroupDepth(d: LayoutDraft, ids: string[]): { patches: Record<string, Partial<LayoutItem>>; aligned: { id: string; to: string }[] } {
  const area = (bb: BBox) => Math.max(0, bb[2] - bb[0]) * Math.max(0, bb[3] - bb[1]);
  const members = d.items.filter((it) => ids.includes(it.id) && it.label !== "text" && bodyOf(it, d).anchor === "world");
  const sorted = [...members].sort((a, b) => area(b.bbox) - area(a.bbox));
  const z = new Map(members.map((m) => [m.id, bodyOf(m, d).z]));
  const patches: Record<string, Partial<LayoutItem>> = {};
  const aligned: { id: string; to: string }[] = [];
  sorted.forEach((m, k) => {
    const a = Math.max(1, area(m.bbox));
    let best: LayoutItem | null = null;
    let bestR = 0;
    for (const c of sorted.slice(0, k)) {
      if (area(c.bbox) <= a) continue;
      const ix = Math.min(m.bbox[2], c.bbox[2]) - Math.max(m.bbox[0], c.bbox[0]);
      const iy = Math.min(m.bbox[3], c.bbox[3]) - Math.max(m.bbox[1], c.bbox[1]);
      const r = ix > 0 && iy > 0 ? (ix * iy) / a : 0;
      if (r > bestR) { bestR = r; best = c; }
    }
    if (!best || bestR < 0.1) return;
    const nz = attachedZ(z.get(best.id)!, d.items.indexOf(m) > d.items.indexOf(best));
    if (Math.abs(nz - z.get(m.id)!) / nz < 0.005) return;
    z.set(m.id, nz);
    patches[m.id] = { body: { ...bodyOf(m, d), z: nz } };
    aligned.push({ id: m.id, to: best.id });
  });
  return { patches, aligned };
}

/**
 * 镜头视图里画新框：rect 是在当前画面里拖出来的矩形。
 * 文字框直接贴在画面上；其余做成 3D 体块——深度取起点下最上层体块的深度（没有就取主体那么远），
 * 再微调原框，让它在当前镜头下的投影正好是 rect。主体深度因此变了时同时给出补偿后的机位（镜头光心不动）。
 */
export function itemFromView(d: LayoutDraft, rect: BBox, label: LayoutItem["label"], start?: { x: number; y: number }): { bbox: BBox; body: Body; camera?: Camera } | null {
  if (label === "text") return { bbox: round2(rect), body: { z: 1, thickness: 0.05, yaw: 0, anchor: "screen" } };
  const W = d.width, H = d.height;
  const F0 = f0(H);
  const cam = clampCamera(d.camera || defaultCamera());
  const pz = subjectZ(d);
  const fr = makeFrame(cam, W, H, pz);
  const fb = makeFrame(defaultCamera(), W, H, pz);
  const pr = projectLayout(d, cam);
  // 深度：起点下最上层的 3D 体块
  let depth = dot(sub([0, 0, F0 * pz], fr.C), fr.fwd);
  if (start) {
    for (let k = pr.order.length - 1; k >= 0; k--) {
      const p = pr.items[pr.order[k]];
      const it = d.items.find((x) => x.id === p.id);
      if (!it || it.hidden || p.anchor !== "world" || !p.visible || !(p.depth > fr.near)) continue;
      const b = p.raw;
      if (start.x >= b[0] && start.x <= b[2] && start.y >= b[1] && start.y <= b[3]) {
        depth = p.depth;
        break;
      }
    }
  }
  if (!(depth > fr.near * 2)) depth = F0 * pz;
  const thick = label === "character" ? 0.45 : 0.3;
  const body0: Body = { z: 1, thickness: thick, yaw: Math.round(wrapDeg(cam.orbit) * 10) / 10, anchor: "world" };
  const c = centerOf(rect);
  const ray: V3 = add(fr.fwd, add(mul(fr.right, (c.x - W / 2) / fr.f), mul(fr.down, (c.y - H / 2) / fr.f)));
  const P = add(fr.C, mul(ray, depth));
  const Ww = ((rect[2] - rect[0]) * depth) / fr.f;
  const Hw = ((rect[3] - rect[1]) * depth) / fr.f;
  const z = Math.round(clamp((P[2] - (thick * Ww) / 2) / F0, 0.15, 20) * 1e4) / 1e4;
  const body: Body = { ...body0, z };
  const bw = Ww / z, bh = Hw / z;
  const cx = P[0] / z + W / 2, cy = P[1] / z + H / 2;
  let bb: BBox = [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2];
  const probe: LayoutItem = { id: "__new", label, caption: "", bbox: bb, color: 0, depth: "auto", body } as LayoutItem;
  const f = (x: BBox) => {
    if (!(x[2] - x[0] > 1 && x[3] - x[1] > 1)) return null;
    const r = projectWorldItem({ ...probe, bbox: x }, body, W, H, fr, fb);
    return r.item.corners && r.item.corners.every(Boolean) ? r.item.raw : null;
  };
  const err = (r: BBox | null) => (r ? Math.max(...r.map((v, i) => Math.abs(v - rect[i]))) : Infinity);
  let cur = f(bb), e0 = err(cur);
  for (let k = 0; k < 14 && cur && e0 > 0.05; k++) {
    const J: number[][] = [[], [], [], []];
    let ok = true;
    for (let j = 0; j < 4 && ok; j++) {
      const h = Math.max(0.25, (bb[2] - bb[0]) * 1e-3);
      const b2 = [...bb] as BBox; b2[j] += h;
      const r = f(b2);
      if (!r) { ok = false; break; }
      for (let i = 0; i < 4; i++) J[i][j] = (r[i] - cur[i]) / h;
    }
    if (!ok) break;
    const step = solve4(J, cur.map((v, i) => rect[i] - v));
    if (!step) break;
    let lam = 1, moved = false;
    for (let t = 0; t < 8; t++, lam /= 2) {
      const nb = bb.map((v, i) => v + step[i] * lam) as BBox;
      const r = f(nb), e = err(r);
      if (e < e0) { bb = nb; cur = r; e0 = e; moved = true; break; }
    }
    if (!moved) break;
  }
  if (!cur) return null;
  const out: { bbox: BBox; body: Body; camera?: Camera } = { bbox: round2(bb), body };
  // 新框成了主体：主体深度变了，补偿机位让画面不跳
  const after: LayoutDraft = { ...d, items: [...d.items, { ...probe, bbox: out.bbox }] };
  const pz1 = subjectZ(after);
  if (Math.abs(pz1 - pz) > 1e-9 && d.camera) out.camera = cameraAt(d.camera, W, H, pz1, fr.C);
  return out;
}

// ---------- 3D 场景（镜头调度室的自由视角 / 光影预览） ----------

export interface SceneItem {
  id: string;
  anchor: Anchor;
  /** 8 个角点（世界坐标，顺序同 cubeCorners）；贴屏框是画框平面上的 4 个点 */
  pts: V3[];
  center: V3;
  body: Body;
  /** 前、后、左、右、上、下 6 个面的角点下标（朝外的绕序不保证，用 faceNormal 判断） */
}

export interface SceneFrame {
  C: V3;
  right: V3;
  down: V3;
  fwd: V3;
  f: number;
  W: number;
  H: number;
}

export interface SceneData {
  items: SceneItem[];
  frame: SceneFrame;
  base: SceneFrame;
  pivot: V3;
  D0: number;
  F0: number;
  /** 地面高度（世界 y，向下为正）：主体底边 */
  ground: number;
  /** 画框平面离镜头的距离（贴屏框画在这里） */
  planeDepth: number;
  /** 场景尺度：1 米对应的世界单位（见 sceneMeter） */
  meter: number;
}

export const CUBE_FACES: number[][] = [
  [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [4, 5, 1, 0], [3, 2, 6, 7],
];

/** 面的朝外法线（单位向量） */
export function faceNormal(pts: V3[], face: number[], center: V3): V3 {
  const a = pts[face[0]], b = pts[face[1]], c = pts[face[2]], e = pts[face[3]];
  let n = cross(sub(c, a), sub(e, b));
  if (Math.hypot(n[0], n[1], n[2]) < 1e-9) n = cross(sub(b, a), sub(c, a));
  n = norm(n);
  const fc = mul(add(add(a, b), add(c, e)), 0.25);
  return dot(n, sub(fc, center)) < 0 ? mul(n, -1) : n;
}

const toSceneFrame = (fr: Frame): SceneFrame => ({ C: fr.C, right: fr.right, down: fr.down, fwd: fr.fwd, f: fr.f, W: fr.W, H: fr.H });

/** 画框（拍摄镜头）上一点 (u, v) 在深度 depth 处的世界坐标 */
export function framePoint(fr: SceneFrame, u: number, v: number, depth: number): V3 {
  return add(fr.C, mul(add(fr.fwd, add(mul(fr.right, (u - fr.W / 2) / fr.f), mul(fr.down, (v - fr.H / 2) / fr.f))), depth));
}

/** 场景尺度：在主体那么远（z = 1）处，占画面高度 60% 的人约 1.8 m。只和画布高度有关，改体块时单位不会跟着变 */
export const sceneMeter = (d: LayoutDraft) => d.height / 3;

export function sceneData(d: LayoutDraft, camIn?: Camera): SceneData {
  const cam = clampCamera(camIn || d.camera || defaultCamera());
  const W = d.width, H = d.height;
  const F0 = f0(H);
  const pz = subjectZ(d);
  const D0 = F0 * pz;
  const fr = toSceneFrame(makeFrame(cam, W, H, pz));
  const fb = toSceneFrame(makeFrame(defaultCamera(), W, H, pz));
  const pivot: V3 = [0, 0, D0];
  const pd = dot(sub(pivot, fr.C), fr.fwd);
  const planeDepth = pd > D0 * 0.05 ? pd : D0;
  const items: SceneItem[] = [];
  for (const it of d.items) {
    const b = bodyOf(it, d);
    if (b.anchor === "screen") {
      const [x1, y1, x2, y2] = it.bbox;
      const pts = [framePoint(fr, x1, y1, planeDepth), framePoint(fr, x2, y1, planeDepth), framePoint(fr, x2, y2, planeDepth), framePoint(fr, x1, y2, planeDepth)];
      items.push({ id: it.id, anchor: "screen", pts, center: framePoint(fr, (x1 + x2) / 2, (y1 + y2) / 2, planeDepth), body: b });
      continue;
    }
    const bb = b.anchor === "backdrop" ? { ...b, thickness: 0 } : b;
    const { pts, center } = cubeCorners(it, bb, W, H);
    items.push({ id: it.id, anchor: b.anchor, pts, center, body: b });
  }
  const subj = subjectItem(d);
  const sp = subj ? items.find((x) => x.id === subj.id) : undefined;
  const ground = sp ? Math.max(...sp.pts.map((p) => p[1])) : H / 2;
  return { items, frame: fr, base: fb, pivot, D0, F0, ground, planeDepth, meter: sceneMeter(d) };
}

/** 体块的世界尺寸（宽、高、厚，世界单位）和底面中心 */
export function bodyMetrics(it: LayoutItem, d: LayoutDraft): { w: number; h: number; t: number; center: V3; bottom: number } {
  const b = bodyOf(it, d);
  const { pts, center } = cubeCorners(it, b, d.width, d.height);
  const w = (it.bbox[2] - it.bbox[0]) * b.z, h = (it.bbox[3] - it.bbox[1]) * b.z;
  return { w, h, t: Math.max(0, b.thickness) * w, center, bottom: Math.max(...pts.map((p) => p[1])) };
}

/**
 * 按世界尺寸改体块：宽 / 厚保持中心不动，高保持底边不动（站在地上的东西不会浮起来）。
 * 返回新的原框和体块（远近 z 不变；改厚度时前脸不动）。
 */
export function resizeBody(it: LayoutItem, d: LayoutDraft, size: { w?: number; h?: number; t?: number }): { bbox: BBox; body: Body } {
  const b = bodyOf(it, d);
  const z = b.z;
  const [x1, y1, x2, y2] = it.bbox;
  const cx = (x1 + x2) / 2;
  const w0 = (x2 - x1) * z, h0 = (y2 - y1) * z;
  const w = Math.max(1, size.w ?? w0), h = Math.max(1, size.h ?? h0);
  const t = size.t ?? Math.max(0, b.thickness) * w0;
  const nb: BBox = [cx - w / z / 2, y2 - h / z, cx + w / z / 2, y2];
  return { bbox: round2(nb), body: { ...b, thickness: Math.round(clamp(t / w, 0, 4) * 1000) / 1000 } };
}
