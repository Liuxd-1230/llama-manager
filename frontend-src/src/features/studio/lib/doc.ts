import type { BBox, Camera, Doc, LayoutDraft, LayoutItem, PerspectiveSettings, PromptOptions } from "../types";
import { defaultLighting, normalizeLighting } from "./lighting";

export const BOX_COLORS = ["#C2552F", "#3E9B6B", "#D9822B", "#C2457A", "#7A5BD1", "#2A97A8"];
export const boxColor = (it: Pick<LayoutItem, "color">, i = 0) =>
  BOX_COLORS[(((it.color ?? i) % BOX_COLORS.length) + BOX_COLORS.length) % BOX_COLORS.length];

export function newId(prefix = "b"): string {
  return prefix + Math.random().toString(36).slice(2, 7) + Date.now().toString(36).slice(-3);
}

export const snap16 = (n: number) => Math.max(64, Math.min(4096, Math.round(n / 16) * 16));

export function defaultCamera(): Camera {
  return { enabled: false, orbit: 0, pitch: 0, roll: 0, distance: 1, fov: 50, pan_x: 0, pan_y: 0, pan_z: 0 };
}

export function defaultPerspective(w: number, h: number): PerspectiveSettings {
  return {
    enabled: false, mode: 1, horizon_y: Math.round(h * 0.42), vp1_x: Math.round(w / 2), vp2_x: Math.round(w * 1.4),
    vp3_x: Math.round(w / 2), vp3_y: Math.round(h * 2.5), show_grid: false, auto_scale: false, source: "manual",
  };
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function emptyLayout(width = 1024, height = 1536): LayoutDraft {
  return {
    width, height, bbox_coord_space: "abs", bbox_format: "xyxy",
    summary: { caption: "", canvas: "single" }, items: [],
    prompt_options: { depth: true, perspective: false, camera: true, lighting: true },
    camera: defaultCamera(),
    lighting: defaultLighting(),
  };
}

export function emptyDoc(kind: Doc["kind"] = "layout"): Doc {
  return { kind, layout: emptyLayout(), caption: { caption: "" } };
}

export function clampBBox(b: number[], W: number, H: number, min = 4): BBox {
  let [x1, y1, x2, y2] = b.map((v) => (Number.isFinite(v) ? v : 0));
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  x1 = Math.round(Math.max(0, Math.min(x1, W - min)));
  y1 = Math.round(Math.max(0, Math.min(y1, H - min)));
  x2 = Math.round(Math.max(x1 + min, Math.min(x2, W)));
  y2 = Math.round(Math.max(y1 + min, Math.min(y2, H)));
  return [x1, y1, x2, y2];
}

export function normalizeLayout(d: Partial<LayoutDraft> | undefined): LayoutDraft {
  const base = emptyLayout(num(d?.width, 1024), num(d?.height, 1536));
  if (!d) return base;
  const used = new Set<string>();
  const items: LayoutItem[] = (Array.isArray(d.items) ? d.items : []).map((raw, i) => {
    const it = { ...(raw as LayoutItem) };
    let id = typeof it.id === "string" && it.id ? it.id : newId();
    while (used.has(id)) id = newId();
    used.add(id);
    const bbox = Array.isArray(it.bbox) && it.bbox.length === 4 ? (it.bbox.map(Number) as BBox) : ([0, 0, 64, 64] as BBox);
    const g = typeof it.group === "string" ? it.group.trim().slice(0, 40) : "";
    delete it.group;
    return {
      ...it,
      ...(g ? { group: g } : {}),
      id,
      bbox,
      label: it.label === "character" || it.label === "text" ? it.label : "object",
      caption: typeof it.caption === "string" ? it.caption : "",
      depth: it.depth === "fg" || it.depth === "mg" || it.depth === "bg" ? it.depth : "auto",
      hidden: !!it.hidden,
      locked: !!it.locked,
      color: typeof it.color === "number" ? it.color : i % BOX_COLORS.length,
    };
  });
  const po = (d.prompt_options || {}) as Partial<PromptOptions>;
  const cam = { ...defaultCamera(), ...(d.camera || {}) } as Camera;
  return {
    ...base,
    ...d,
    width: base.width,
    height: base.height,
    bbox_coord_space: "abs",
    bbox_format: "xyxy",
    summary: { canvas: "single", ...(d.summary || {}), caption: d.summary?.caption ?? "" },
    items: pruneGroups(items),
    prompt_options: { depth: po.depth !== false, perspective: !!po.perspective, camera: po.camera !== false, lighting: po.lighting !== false },
    camera: cam,
    lighting: normalizeLighting(d.lighting),
  };
}

export function normalizeDoc(doc: Partial<Doc> | undefined | null): Doc {
  if (!doc) return emptyDoc();
  return {
    kind: doc.kind === "caption" ? "caption" : "layout",
    layout: normalizeLayout(doc.layout),
    caption: { caption: doc.caption?.caption ?? "" },
  };
}

// ---------- 成组 ----------
/** 只剩一个成员的组自动解散 */
export function pruneGroups(items: LayoutItem[]): LayoutItem[] {
  const n = new Map<string, number>();
  for (const it of items) if (it.group) n.set(it.group, (n.get(it.group) || 0) + 1);
  if (![...n.values()].some((c) => c < 2) && !items.some((it) => "group" in it && !it.group)) return items;
  return items.map((it) => {
    if (it.group && (n.get(it.group) || 0) >= 2) return it;
    if (!("group" in it)) return it;
    const { group: _g, ...rest } = it; // eslint-disable-line @typescript-eslint/no-unused-vars
    return rest as LayoutItem;
  });
}

/** 同组的框（含自己，按图层顺序）；不在组里就只有自己 */
export function groupOf(items: LayoutItem[], id: string): string[] {
  const it = items.find((x) => x.id === id);
  if (!it) return [];
  if (!it.group) return [id];
  return items.filter((x) => x.group === it.group).map((x) => x.id);
}

/** 把一组 id 扩展到整组（保持图层顺序） */
export function expandGroups(items: LayoutItem[], ids: string[]): string[] {
  const want = new Set(ids);
  const groups = new Set(items.filter((x) => want.has(x.id) && x.group).map((x) => x.group!));
  return items.filter((x) => want.has(x.id) || (x.group && groups.has(x.group))).map((x) => x.id);
}

/** 组编号：按图层里第一次出现的顺序 1、2、3… */
export function groupNumbers(items: LayoutItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) if (it.group && !out.has(it.group)) out.set(it.group, out.size + 1);
  return out;
}

/** ids 正好是一个完整的组时返回组 id */
export function wholeGroup(items: LayoutItem[], ids: string[]): string | null {
  if (ids.length < 2) return null;
  const g = items.find((x) => x.id === ids[0])?.group;
  if (!g) return null;
  const members = items.filter((x) => x.group === g).map((x) => x.id);
  return members.length === ids.length && members.every((id) => ids.includes(id)) ? g : null;
}

export function itemName(it: LayoutItem, i?: number): string {
  return (
    it.name?.trim() ||
    (it.label === "text" && it.text?.trim()) ||
    it.caption?.trim().slice(0, 14) ||
    (i !== undefined ? `框 ${i + 1}` : it.id)
  );
}

/** 等比缩放到新画布并居中；贴满全宽/全高的框继续贴边（背景板之类） */
export function fitItemsToCanvas(d: LayoutDraft, W: number, H: number): LayoutDraft {
  const s = Math.min(W / d.width, H / d.height);
  const ox = (W - d.width * s) / 2;
  const oy = (H - d.height * s) / 2;
  const items = d.items.map((it) => {
    const [x1, y1, x2, y2] = it.bbox;
    let nb = [x1 * s + ox, y1 * s + oy, x2 * s + ox, y2 * s + oy];
    if (x1 <= 2 && x2 >= d.width - 2) nb = [0, nb[1], W, nb[3]];
    if (y1 <= 2 && y2 >= d.height - 2) nb = [nb[0], 0, nb[2], H];
    return { ...it, bbox: clampBBox(nb, W, H) };
  });
  return { ...d, width: W, height: H, items };
}

export function bboxArea(b: BBox) {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
