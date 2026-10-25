/**
 * 灯光：数据、预设、提示词短语（与 server/lighting.py 逐字一致）、预览着色。
 * 方向约定和机位一样：azimuth 像环绕角（0 = 从初始机位一侧照向主体，正 = 画面右侧，180 = 背后），elevation 像俯仰（正 = 从上往下照）。
 * 预设里的方位是「相对当前机位」的，套用时加上机位环绕角，之后灯固定在场景里（follow = true 时灯跟着机位转）。
 */
import DATA from "./lighting_data.json";
import type { Camera, Light, LightRole, Lighting } from "../types";

type V3 = [number, number, number];
export type RGB = [number, number, number];

export interface LightPresetLight {
  role: LightRole;
  azimuth: number;
  elevation: number;
  intensity: number;
  kelvin?: number;
  color?: string;
  softness: number;
}
export interface LightPreset {
  id: string;
  name: string;
  desc: string;
  zh: string;
  en: string;
  ambient: number;
  ambient_kelvin: number;
  extras?: string[];
  lights: LightPresetLight[];
}
export interface LightExtra {
  id: string;
  label: string;
  zh: string;
  en: string;
}

export const ROLES = DATA.roles as Record<LightRole, { zh: string; en: string; short: string }>;
export const ROLE_ORDER: LightRole[] = ["key", "fill", "rim", "bg", "practical"];
export const LIGHT_PRESETS = DATA.presets as LightPreset[];
export const LIGHT_EXTRAS = DATA.extras as LightExtra[];
const PRESET_BY_ID = new Map(LIGHT_PRESETS.map((p) => [p.id, p]));
const EXTRA_BY_ID = new Map(LIGHT_EXTRAS.map((e) => [e.id, e]));
export const presetById = (id: string) => PRESET_BY_ID.get(id);

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

// ---------- 数据 ----------
export function defaultLighting(): Lighting {
  return { enabled: false, preset: "", lights: [], ambient: 0.35, ambient_kelvin: 6500, extras: [], note: "", follow: false };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
let seq = 0;
export const newLightId = () => "l" + Math.random().toString(36).slice(2, 6) + (seq++).toString(36);

export function normalizeLight(raw: Partial<Light> | undefined, i = 0): Light {
  const l = (raw || {}) as Partial<Light>;
  const role: LightRole = ROLE_ORDER.includes(l.role as LightRole) ? (l.role as LightRole) : i === 0 ? "key" : "fill";
  const kelvin = l.kelvin === null ? null : typeof l.kelvin === "number" && Number.isFinite(l.kelvin) ? Math.round(clamp(l.kelvin, 1000, 20000)) : HEX.test(l.color || "") ? null : 5600;
  return {
    id: typeof l.id === "string" && l.id ? l.id : newLightId(),
    role,
    enabled: l.enabled !== false,
    azimuth: r1(wrap(num(l.azimuth, 0))),
    elevation: r1(clamp(num(l.elevation, 30), -89, 89)),
    intensity: r2(clamp(num(l.intensity, 1), 0, 2)),
    kelvin,
    color: kelvin !== null ? kelvinHex(kelvin) : HEX.test(l.color || "") ? l.color!.toLowerCase() : "#ffffff",
    softness: r2(clamp(num(l.softness, 0.5), 0, 1)),
  };
}

export function normalizeLighting(raw: unknown): Lighting {
  const d = defaultLighting();
  if (!raw || typeof raw !== "object") return d;
  const g = raw as Partial<Lighting>;
  const used = new Set<string>();
  const lights = (Array.isArray(g.lights) ? g.lights : []).slice(0, 8).map((l, i) => {
    const n = normalizeLight(l, i);
    while (used.has(n.id)) n.id = newLightId();
    used.add(n.id);
    return n;
  });
  return {
    enabled: !!g.enabled,
    preset: typeof g.preset === "string" && PRESET_BY_ID.has(g.preset) ? g.preset : "",
    lights,
    ambient: r2(clamp(num(g.ambient, d.ambient), 0, 1)),
    ambient_kelvin: Math.round(clamp(num(g.ambient_kelvin, d.ambient_kelvin), 1000, 20000)),
    extras: (Array.isArray(g.extras) ? g.extras : []).filter((x, i, a) => typeof x === "string" && EXTRA_BY_ID.has(x) && a.indexOf(x) === i),
    note: typeof g.note === "string" ? g.note.slice(0, 400) : "",
    follow: !!g.follow,
  };
}

/** 套用预设：预设方位相对当前机位 */
export function presetLighting(id: string, cam: Camera | undefined, cur?: Lighting): Lighting {
  const p = PRESET_BY_ID.get(id);
  const base = cur || defaultLighting();
  if (!p) return base;
  const follow = base.follow;
  const o = follow ? 0 : camOrbit(cam);
  return normalizeLighting({
    ...base,
    enabled: true,
    preset: id,
    ambient: p.ambient,
    ambient_kelvin: p.ambient_kelvin,
    extras: p.extras ? [...p.extras] : [],
    lights: p.lights.map((l) => ({
      id: newLightId(), role: l.role, enabled: true, azimuth: wrap(l.azimuth + o), elevation: l.elevation,
      intensity: l.intensity, kelvin: l.kelvin ?? null, color: l.color || "#ffffff", softness: l.softness,
    })),
  });
}

const camOrbit = (cam?: Camera | null) => (cam && cam.enabled ? num(cam.orbit, 0) : 0);

// ---------- 颜色 ----------
export function kelvinRgb(k: number): RGB {
  const t = clamp(k, 1000, 40000) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [clamp(r, 0, 255) / 255, clamp(g, 0, 255) / 255, clamp(b, 0, 255) / 255];
}
export const hexRgb = (h: string): RGB => {
  const m = HEX.test(h) ? h : "#ffffff";
  return [parseInt(m.slice(1, 3), 16) / 255, parseInt(m.slice(3, 5), 16) / 255, parseInt(m.slice(5, 7), 16) / 255];
};
export const rgbHex = (c: RGB) => "#" + c.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, "0")).join("");
export const kelvinHex = (k: number) => rgbHex(kelvinRgb(k));
export const lightRgb = (l: Light): RGB => (l.kelvin !== null ? kelvinRgb(l.kelvin) : hexRgb(l.color));

function hueWord(hex: string, zh: boolean): string {
  const [r, g, b] = hexRgb(hex);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const s = mx === mn ? 0 : l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
  if (s < 0.2) return "";
  let h = 0;
  if (mx === r) h = ((g - b) / (mx - mn)) % 6;
  else if (mx === g) h = (b - r) / (mx - mn) + 2;
  else h = (r - g) / (mx - mn) + 4;
  h = ((h * 60) % 360 + 360) % 360;
  const bins: [number, string, string][] = [
    [15, "红色", "red"], [40, "橙色", "orange"], [65, "黄色", "yellow"], [160, "绿色", "green"], [200, "青色", "cyan"],
    [250, "蓝色", "blue"], [290, "紫色", "purple"], [345, "品红色", "magenta"], [361, "红色", "red"],
  ];
  const hit = bins.find((x) => h < x[0])!;
  return zh ? hit[1] : hit[2];
}

function colorWord(l: Light, zh: boolean): string {
  if (l.kelvin === null) return hueWord(l.color, zh);
  const k = l.kelvin;
  if (k < 2300) return zh ? "橙红色" : "deep orange";
  if (k < 3300) return zh ? "暖金色" : "warm golden";
  if (k < 4500) return zh ? "偏暖" : "warm";
  if (k < 6800) return "";
  if (k < 8000) return zh ? "偏冷" : "cool";
  return zh ? "冷蓝色" : "cold blue";
}

// ---------- 方向 ----------
export interface CamBasis {
  right: V3;
  down: V3;
  /** 从主体指向镜头 */
  toCam: V3;
}

export function camBasis(cam?: Camera | null): CamBasis {
  const on = !!cam && cam.enabled;
  const o = rad(on ? num(cam!.orbit, 0) : 0), p = rad(on ? clamp(num(cam!.pitch, 0), -85, 85) : 0), rr = rad(on ? num(cam!.roll, 0) : 0);
  const dir: V3 = [Math.sin(o) * Math.cos(p), -Math.sin(p), -Math.cos(o) * Math.cos(p)];
  const fwd: V3 = [-dir[0], -dir[1], -dir[2]];
  const right0 = norm(cross(fwd, [0, -1, 0]));
  const down0 = cross(fwd, right0);
  const right: V3 = [0, 1, 2].map((i) => right0[i] * Math.cos(rr) + down0[i] * Math.sin(rr)) as V3;
  const down: V3 = [0, 1, 2].map((i) => down0[i] * Math.cos(rr) - right0[i] * Math.sin(rr)) as V3;
  return { right, down, toCam: dir };
}

/** 灯在世界里的方位角（follow 时加上机位环绕） */
export const worldAzimuth = (l: Light, lg: Lighting, cam?: Camera | null) => wrap(l.azimuth + (lg.follow ? camOrbit(cam) : 0));

/** 方位 / 高度 → 单位向量（从主体指向灯） */
export function lightVec(az: number, el: number): V3 {
  const a = rad(az), e = rad(el);
  return [Math.sin(a) * Math.cos(e), -Math.sin(e), -Math.cos(a) * Math.cos(e)];
}
export function vecAngles(v: V3): { azimuth: number; elevation: number } {
  const n = norm(v);
  return { azimuth: r1(wrap(deg(Math.atan2(n[0], -n[2])))), elevation: r1(clamp(deg(Math.asin(clamp(-n[1], -1, 1))), -89, 89)) };
}

export interface RelDir {
  /** 画面里的水平角：0 = 正面（从镜头方向），负 = 左，正 = 右，±180 = 正后方 */
  h: number;
  /** 画面里的高度角：正 = 从上方 */
  v: number;
  side: number;
  up: number;
  front: number;
}

/**
 * 灯相对镜头的方向。h：水平面里相对机位的方位（描述「左前方 / 右侧 / 背后」）；v：灯的世界高度角（「高处 / 平视 / 底光」不随镜头俯仰变）。
 * side / up / front：在镜头坐标系里的分量（灯光球用）。
 */
export function relDir(l: Light, lg: Lighting, cam?: Camera | null, B: CamBasis = camBasis(cam)): RelDir {
  const az = worldAzimuth(l, lg, cam);
  const L = lightVec(az, l.elevation);
  const side = dot(L, B.right), up = -dot(L, B.down), front = dot(L, B.toCam);
  return { h: wrap(az - camOrbit(cam)), v: l.elevation, side, up, front };
}

/** 相对镜头的方向（灯光球上拖出来的）→ 存储用的方位 / 高度 */
export function fromRel(side: number, up: number, front: number, lg: Lighting, cam?: Camera | null): { azimuth: number; elevation: number } {
  const B = camBasis(cam);
  const v: V3 = [0, 1, 2].map((i) => B.right[i] * side - B.down[i] * up + B.toCam[i] * front) as V3;
  const a = vecAngles(v);
  return { azimuth: r1(wrap(a.azimuth - (lg.follow ? camOrbit(cam) : 0))), elevation: a.elevation };
}

function directionText(h: number, v: number, zh: boolean): string {
  if (v >= 65) return zh ? "正上方" : "directly overhead";
  if (v <= -65) return zh ? "正下方" : "directly below";
  const ah = Math.abs(h);
  const left = h < 0;
  let horiz: string;
  if (ah <= 20) horiz = zh ? "正前方" : "the front";
  else if (ah <= 65) horiz = zh ? (left ? "左前方" : "右前方") : left ? "the front left" : "the front right";
  else if (ah <= 115) horiz = zh ? (left ? "左侧" : "右侧") : left ? "the left side" : "the right side";
  else if (ah <= 160) horiz = zh ? (left ? "左后方" : "右后方") : left ? "behind on the left" : "behind on the right";
  else horiz = zh ? "正后方" : "directly behind";
  const d = Math.floor(Math.abs(v) / 5 + 0.5) * 5;
  let vert: string;
  if (v >= 30) vert = zh ? `高处（约 ${d}°）` : `high above (about ${d} degrees)`;
  else if (v >= 10) vert = zh ? "略高处" : "slightly above";
  else if (v > -10) vert = zh ? "平视高度" : "at eye level";
  else vert = zh ? `低处（约 ${d}°，由下往上）` : `from below (about ${d} degrees)`;
  return zh ? horiz + vert : `${horiz}, ${vert}`;
}

/** 套用的预设在当前机位下还成立吗（机位转了以后主光可能已经跑到别的方向） */
export function presetMatches(lg: Lighting, cam?: Camera | null): boolean {
  const p = PRESET_BY_ID.get(lg.preset);
  if (!p || !p.lights.length) return false;
  const pl = p.lights[0];
  const l = lg.lights.find((x) => x.enabled && x.role === pl.role);
  if (!l) return false;
  const r = relDir(l, lg, cam);
  return Math.abs(Math.abs(r.h) - Math.abs(pl.azimuth)) <= 30 && Math.abs(r.v - pl.elevation) <= 25;
}

const activeLights = (lg: Lighting) => lg.lights.filter((l) => l.enabled && l.intensity > 0.02);

function lightClause(l: Light, lg: Lighting, cam: Camera | null | undefined, keyI: number, zh: boolean): string {
  const r = relDir(l, lg, cam);
  const dir = directionText(r.h, r.v, zh);
  const ratio = keyI > 0 ? l.intensity / keyI : 1;
  let strength = "";
  if (l.role === "key") {
    if (l.intensity >= 1.25) strength = zh ? "强烈" : "strong";
    else if (l.intensity <= 0.5) strength = zh ? "微弱" : "dim";
  } else if (ratio < 0.3) strength = zh ? "微弱" : "faint";
  else if (ratio >= 1.1) strength = zh ? "强烈" : "strong";
  const quality = l.softness <= 0.25 ? (zh ? "硬朗" : "hard") : l.softness >= 0.7 ? (zh ? "柔和漫射" : "soft diffused") : "";
  const color = colorWord(l, zh);
  const role = ROLES[l.role];
  if (zh) {
    const adj = [strength, quality].filter(Boolean).join("、");
    const light = (adj ? adj + "的" : "") + color + "光";
    const plain = light === "光";
    if (l.role === "bg") return plain ? "背景光照亮主体身后的背景" : `背景光为${light}，照亮主体身后的背景`;
    if (l.role === "practical") return `场景中有${plain ? "" : light.slice(0, -1) + "的"}实景光源，从${dir}照来`;
    if (l.role === "rim") return plain ? `轮廓光从${dir}勾勒边缘` : `轮廓光为${light}，从${dir}勾勒边缘`;
    return plain ? `${role.zh}从${dir}照来` : `${role.zh}为${light}，从${dir}照来`;
  }
  const adj = [strength, quality, color].filter(Boolean).join(" ");
  const pre = adj ? adj + " " : "";
  if (l.role === "bg") return `${pre}background light illuminating the backdrop behind the subject`;
  if (l.role === "practical") return `${pre}practical light source visible in the scene, coming from ${dir}`;
  if (l.role === "rim") return `${pre}rim light from ${dir}, outlining the edges`;
  return `${pre}${role.en} from ${dir}`;
}

function toneClause(lg: Lighting, on: Light[], zh: boolean): string {
  const amb = lg.ambient;
  const keys = on.filter((l) => l.role === "key");
  const keyI = keys.length ? Math.max(...keys.map((l) => l.intensity)) : on.length ? Math.max(...on.map((l) => l.intensity)) : 0;
  const fill = on.filter((l) => l.role === "fill").reduce((s, l) => s + l.intensity, 0);
  let out: string;
  if (!on.length) {
    if (amb >= 0.6) out = zh ? "整体明亮通透，光线均匀" : "bright, even ambient light";
    else if (amb <= 0.1) out = zh ? "环境非常昏暗" : "very dark surroundings";
    else return "";
  } else {
    const ratio = (keyI + 0.001) / (fill + amb + 0.05);
    if (amb >= 0.65 && ratio < 2.2) out = zh ? "整体明亮通透，反差低，阴影柔和" : "bright, airy, low-contrast lighting with soft shadows";
    else if (ratio >= 6 || amb <= 0.08) out = zh ? "环境昏暗，阴影浓重，明暗对比强烈" : "dark surroundings, deep shadows and high contrast (chiaroscuro)";
    else if (ratio >= 3) out = zh ? "中等反差，阴影清晰" : "moderate contrast with defined shadows";
    else out = zh ? "反差柔和，暗部通透" : "gentle contrast with soft, open shadows";
  }
  if (amb >= 0.25) {
    if (lg.ambient_kelvin >= 8500) out += zh ? "，环境色调偏冷蓝" : ", with a cool blue ambient tone";
    else if (lg.ambient_kelvin <= 3800) out += zh ? "，环境色调偏暖" : ", with a warm ambient tone";
  }
  return out;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const stripEnd = (s: string) => s.trim().replace(/[\s。.!！;；,，]+$/u, "");

/** 灯光 → 提示词短语。lighting 关闭或没有内容时返回空串 */
export function lightingPhrase(lgIn: Lighting | undefined | null, cam: Camera | undefined | null, zh: boolean): string {
  if (!lgIn || !lgIn.enabled) return "";
  const lg = normalizeLighting(lgIn);
  const on = activeLights(lg);
  const parts: string[] = [];
  const p = PRESET_BY_ID.get(lg.preset);
  if (p && presetMatches(lg, cam)) parts.push(zh ? p.zh : p.en);
  const keys = on.filter((l) => l.role === "key");
  const keyI = keys.length ? Math.max(...keys.map((l) => l.intensity)) : on.length ? Math.max(...on.map((l) => l.intensity)) : 0;
  const sorted = [...on].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || b.intensity - a.intensity);
  for (const l of sorted.slice(0, 5)) parts.push(lightClause(l, lg, cam, keyI, zh));
  const sentences: string[] = [];
  if (parts.length) sentences.push(parts.join(zh ? "；" : "; "));
  const tone = toneClause(lg, on, zh);
  if (tone) sentences.push(tone);
  const ex = lg.extras.map((id) => EXTRA_BY_ID.get(id)).filter(Boolean).map((e) => (zh ? e!.zh : e!.en));
  if (ex.length) sentences.push(ex.join(zh ? "，" : ", "));
  const note = stripEnd(lg.note);
  if (note) sentences.push(note);
  if (!sentences.length) return "";
  if (zh) return "光线：" + sentences.join("。") + "。";
  return "Lighting: " + sentences.map(cap).join(". ") + ".";
}

// ---------- 预览着色 ----------
export interface WorldLight {
  L: V3;
  rgb: RGB;
  intensity: number;
  softness: number;
  role: LightRole;
  id: string;
}

export function worldLights(lg: Lighting, cam?: Camera | null): WorldLight[] {
  return activeLights(lg).map((l) => ({
    id: l.id, role: l.role, intensity: l.intensity, softness: l.softness, rgb: lightRgb(l),
    L: lightVec(worldAzimuth(l, lg, cam), l.elevation),
  }));
}

const tone = (x: number) => Math.pow(1 - Math.exp(-1.5 * Math.max(0, x)), 1.7);

/** 漫反射（带柔光包裹）着色，n 是世界法线；返回 0–1 RGB */
export function shade(n: V3, base: RGB, wl: WorldLight[], lg: Lighting): RGB {
  const ar = kelvinRgb(lg.ambient_kelvin);
  const acc: RGB = [lg.ambient * ar[0], lg.ambient * ar[1], lg.ambient * ar[2]];
  for (const l of wl) {
    const w = l.softness * 0.6;
    const k = Math.max(0, (dot(n, l.L) + w) / (1 + w)) * l.intensity * (l.role === "bg" ? 0.5 : 1);
    acc[0] += l.rgb[0] * k; acc[1] += l.rgb[1] * k; acc[2] += l.rgb[2] * k;
  }
  return [base[0] * tone(acc[0]), base[1] * tone(acc[1]), base[2] * tone(acc[2])];
}

/** 背景板 / 画面底色的亮度（背景光照亮它，别的灯只带一点） */
export function backdropShade(base: RGB, wl: WorldLight[], lg: Lighting): RGB {
  const ar = kelvinRgb(lg.ambient_kelvin);
  const acc: RGB = [lg.ambient * ar[0] * 1.1, lg.ambient * ar[1] * 1.1, lg.ambient * ar[2] * 1.1];
  for (const l of wl) {
    const k = l.intensity * (l.role === "bg" ? 0.9 : 0.22 + 0.15 * Math.max(0, -l.L[2]));
    acc[0] += l.rgb[0] * k; acc[1] += l.rgb[1] * k; acc[2] += l.rgb[2] * k;
  }
  return [base[0] * tone(acc[0]), base[1] * tone(acc[1]), base[2] * tone(acc[2])];
}

/**
 * 在 canvas 上画一个被灯照亮的球（灯光球 / 预设缩略图）。lights 用相对镜头的方向（side 右、up 上、front 朝镜头）。
 */
export function paintLitSphere(ctx: CanvasRenderingContext2D, size: number, rel: { side: number; up: number; front: number; rgb: RGB; intensity: number; softness: number; role: LightRole }[], ambient: number, ambientRgb: RGB, bg = "#00000000") {
  const img = ctx.createImageData(size, size);
  const R = size / 2 - 1;
  const bgc = hexRgb(bg.length === 9 ? bg.slice(0, 7) : bg);
  const bga = bg.length === 9 ? parseInt(bg.slice(7, 9), 16) : 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const sx = (x + 0.5 - size / 2) / R, sy = -(y + 0.5 - size / 2) / R;
      const rr = sx * sx + sy * sy;
      if (rr > 1) {
        img.data[i] = bgc[0] * 255; img.data[i + 1] = bgc[1] * 255; img.data[i + 2] = bgc[2] * 255; img.data[i + 3] = bga;
        continue;
      }
      const sz = Math.sqrt(1 - rr);
      let r = ambient * ambientRgb[0], g = ambient * ambientRgb[1], b = ambient * ambientRgb[2];
      for (const l of rel) {
        const d = sx * l.side + sy * l.up + sz * l.front;
        const w = l.softness * 0.6;
        const k = Math.max(0, (d + w) / (1 + w)) * l.intensity * (l.role === "bg" ? 0.35 : 1);
        // 高光：硬光才明显
        const rz = 2 * d * sz - l.front;
        const spec = d > 0 ? Math.pow(Math.max(0, rz), 12 + (1 - l.softness) * 50) * (1 - l.softness) * 0.45 * l.intensity : 0;
        r += l.rgb[0] * (k + spec); g += l.rgb[1] * (k + spec); b += l.rgb[2] * (k + spec);
      }
      const edge = Math.min(1, (1 - Math.sqrt(rr)) * R * 1.2);
      const base = 1;
      const mix = (c: number, bc: number) => (base * tone(c) * edge + bc * (1 - edge)) * 255;
      img.data[i] = mix(r, bgc[0]); img.data[i + 1] = mix(g, bgc[1]); img.data[i + 2] = mix(b, bgc[2]);
      img.data[i + 3] = Math.round(255 * edge + bga * (1 - edge));
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** 灯光在当前机位下的相对方向（给灯光球用） */
export function relLights(lg: Lighting, cam?: Camera | null) {
  const B = camBasis(cam);
  return activeLights(lg).map((l) => {
    const r = relDir(l, lg, cam, B);
    return { id: l.id, side: r.side, up: r.up, front: r.front, rgb: lightRgb(l), intensity: l.intensity, softness: l.softness, role: l.role };
  });
}

/** 预设缩略图用：预设直接按相对镜头的方位 */
export function presetRel(p: LightPreset) {
  return p.lights.map((l) => {
    const L = lightVec(l.azimuth, l.elevation);
    // 默认机位：right = +x，down = +y，toCam = -z
    return {
      side: L[0], up: -L[1], front: -L[2], rgb: l.kelvin ? kelvinRgb(l.kelvin) : hexRgb(l.color || "#ffffff"),
      intensity: l.intensity, softness: l.softness, role: l.role,
    };
  });
}

/** 新加一盏灯的默认值 */
export function newLight(role: LightRole, cam?: Camera | null, follow = false): Light {
  const o = follow ? 0 : camOrbit(cam);
  const d: Record<LightRole, Partial<Light>> = {
    key: { azimuth: -40, elevation: 35, intensity: 1, kelvin: 5200, softness: 0.5 },
    fill: { azimuth: 45, elevation: 10, intensity: 0.35, kelvin: 5600, softness: 0.85 },
    rim: { azimuth: 150, elevation: 30, intensity: 0.7, kelvin: 6500, softness: 0.3 },
    bg: { azimuth: 180, elevation: 5, intensity: 0.6, kelvin: 6000, softness: 0.9 },
    practical: { azimuth: 35, elevation: 0, intensity: 0.7, kelvin: 2700, softness: 0.6 },
  };
  const x = d[role];
  return normalizeLight({ ...x, role, enabled: true, azimuth: wrap((x.azimuth || 0) + o) });
}

export const LIGHT_SWATCHES = ["#ff3b30", "#ff9500", "#ffd60a", "#34c759", "#20c8ff", "#0a84ff", "#8e5cf7", "#ff2e88", "#ffffff"];
export const KELVIN_STEPS = [1900, 2700, 3200, 4300, 5600, 6500, 8000, 10000];

/** 给 Agent / 界面看的灯光摘要（一行一盏灯） */
export function lightingSummaryZh(lg: Lighting, cam?: Camera | null): string[] {
  return activeLights(lg).map((l) => {
    const r = relDir(l, lg, cam);
    return `${ROLES[l.role].zh} ${directionText(r.h, r.v, true)} · 强度 ${l.intensity} · ${l.kelvin !== null ? l.kelvin + "K" : l.color}`;
  });
}
