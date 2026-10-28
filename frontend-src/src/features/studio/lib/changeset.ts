/** 待确认改动：把两版文档的差异拆成可逐条采纳的条目，并能只应用选中的部分。 */
import type { Doc, LayoutItem } from "../types";
import { LABEL_TEXT } from "../types";
import { clone, deepEqual, itemName } from "./doc";
import { lightingSummaryZh, presetById } from "./lighting";

export type ChangeKind = "segment" | "kind" | "caption" | "canvas" | "summary" | "camera" | "lighting" | "add" | "remove" | "update" | "order";

export interface Change {
  key: string;
  kind: ChangeKind;
  title: string;
  fields?: string[];
  before?: string;
  after?: string;
  itemId?: string;
}

const FIELD_TEXT: Record<string, string> = {
  caption: "描述", bbox: "位置", label: "类型", text: "文字", name: "名称", depth: "景深",
  body: "体块", hidden: "显隐", locked: "锁定", tags: "标签", palette: "配色", color: "颜色", group: "成组",
};

export function diffDocs(base: Doc, next: Doc): Change[] {
  const out: Change[] = [];
  if (base.kind !== next.kind)
    out.push({ key: "kind", kind: "kind", title: `页面类型改为 ${next.kind === "layout" ? "Layout" : "Caption"}` });
  const oldSegments=base.caption.segments || [];
  const newSegments=next.caption.segments || [];
  if (oldSegments.length || newSegments.length) {
    const before=new Map(oldSegments.map(s=>[s.id,s]));
    const after=new Map(newSegments.map(s=>[s.id,s]));
    for(const id of new Set([...before.keys(),...after.keys()])) {
      const a=before.get(id),b=after.get(id);
      if(!deepEqual(a,b)) out.push({key:`seg:${id}`,kind:'segment',itemId:id,title:`段落「${b?.name || a?.name || '成稿'}」`,before:a?.text,after:b?.text});
    }
  } else if ((base.caption.caption || '') !== (next.caption.caption || '')) {
    out.push({key:'caption',kind:'caption',title:'成稿文本',before:base.caption.caption,after:next.caption.caption});
  }
  const a = base.layout;
  const b = next.layout;
  if (a.width !== b.width || a.height !== b.height)
    out.push({ key: "canvas", kind: "canvas", title: `画布 ${a.width}×${a.height} → ${b.width}×${b.height}` });
  if (!deepEqual(a.summary, b.summary)) {
    const capChanged = (a.summary.caption || "") !== (b.summary.caption || "");
    out.push({
      key: "summary", kind: "summary", title: capChanged ? "整体描述" : "整体设定（标签/画布类型）",
      before: a.summary.caption, after: b.summary.caption,
    });
  }
  if (!deepEqual(a.camera, b.camera)) out.push({ key: "camera", kind: "camera", title: "机位参数" });
  if (!deepEqual(a.lighting ?? null, b.lighting ?? null) || !!a.prompt_options?.lighting !== !!b.prompt_options?.lighting) {
    const pn = b.lighting?.preset ? presetById(b.lighting.preset)?.name : "";
    const title = !b.lighting?.enabled ? "关闭灯光" : `灯光${pn ? `：${pn}` : "（自定义）"}`;
    const sum = (d: typeof a) => (d.lighting?.enabled ? lightingSummaryZh(d.lighting, d.camera).join("；") : "");
    out.push({ key: "lighting", kind: "lighting", title, before: sum(a), after: sum(b) });
  }

  const am = new Map(a.items.map((it) => [it.id, it]));
  const bm = new Map(b.items.map((it) => [it.id, it]));
  b.items.forEach((it, i) => {
    const old = am.get(it.id);
    if (!old) {
      out.push({ key: `add:${it.id}`, kind: "add", itemId: it.id, title: `新增 ${LABEL_TEXT[it.label]}「${itemName(it, i)}」`, after: it.caption });
      return;
    }
    const fields = Object.keys(FIELD_TEXT).filter((k) => !deepEqual((old as any)[k], (it as any)[k]));
    if (fields.length)
      out.push({
        key: `up:${it.id}`, kind: "update", itemId: it.id, fields,
        title: `修改「${itemName(it, i)}」：${fields.map((f) => FIELD_TEXT[f]).join("、")}`,
        before: fields.includes("caption") ? old.caption : fields.includes("text") ? old.text : undefined,
        after: fields.includes("caption") ? it.caption : fields.includes("text") ? it.text : undefined,
      });
  });
  a.items.forEach((it, i) => {
    if (!bm.has(it.id)) out.push({ key: `rm:${it.id}`, kind: "remove", itemId: it.id, title: `删除「${itemName(it, i)}」` });
  });
  const common = (xs: LayoutItem[]) => xs.filter((it) => am.has(it.id) && bm.has(it.id)).map((it) => it.id);
  if (!deepEqual(common(a.items), common(b.items))) out.push({ key: "order", kind: "order", title: "调整图层顺序" });
  return out;
}

/**
 * 把 base→next 的差异里被选中的条目应用到 target（通常就是 base，或用户期间又改过的当前文档）。
 */
export function applyChanges(target: Doc, base: Doc, next: Doc, accepted: Set<string>): Doc {
  const out = clone(target);
  const changes = diffDocs(base, next);
  const on = (k: string) => accepted.has(k) && changes.some((c) => c.key === k);
  if (on("kind")) out.kind = next.kind;
  if (on("caption")) out.caption = clone(next.caption);
  if (changes.some(c=>c.kind==='segment' && on(c.key))) {
    const after=new Map((next.caption.segments || []).map(s=>[s.id,s]));
    let segments=(out.caption.segments || []).filter(s=>s.locked || !on(`seg:${s.id}`) || after.has(s.id)).map(s=>on(`seg:${s.id}`) && !s.locked ? clone(after.get(s.id)!) : s);
    for(const segment of next.caption.segments || []) if(on(`seg:${segment.id}`) && !segments.some(s=>s.id===segment.id)) segments.push(clone(segment));
    out.caption={caption:segments.map(s=>s.text).join('\n'),segments};
  }
  const L = out.layout;
  const N = next.layout;
  if (on("canvas")) {
    L.width = N.width;
    L.height = N.height;
  }
  if (on("summary")) L.summary = clone(N.summary);
  if (on("camera")) {
    L.camera = clone(N.camera);
    L.prompt_options = clone(N.prompt_options);
  }
  if (on("lighting")) {
    L.lighting = clone(N.lighting);
    L.prompt_options = { depth: true, perspective: false, camera: true, ...L.prompt_options, lighting: N.prompt_options?.lighting !== false };
  }
  const nm = new Map(N.items.map((it) => [it.id, it]));
  let items = L.items.filter((it) => !on(`rm:${it.id}`)).map((it) => (on(`up:${it.id}`) && nm.has(it.id) ? clone(nm.get(it.id)!) : it));
  // 新增：插到 next 里它前一个已存在元素的后面
  N.items.forEach((it, i) => {
    if (!on(`add:${it.id}`) || items.some((x) => x.id === it.id)) return;
    let pos = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = items.findIndex((x) => x.id === N.items[j].id);
      if (k >= 0) {
        pos = k + 1;
        break;
      }
    }
    items.splice(pos, 0, clone(it));
  });
  if (on("order")) {
    const idx = new Map(N.items.map((it, i) => [it.id, i]));
    let last = -1;
    const keyed = items.map((it) => {
      const k = idx.has(it.id) ? idx.get(it.id)! : last + 0.001;
      last = k;
      return { it, k };
    });
    items = keyed.sort((x, y) => x.k - y.k).map((x) => x.it);
  }
  L.items = items;
  return out;
}

// ---------- 词级 diff（描述改动预览） ----------
export interface DiffSeg {
  t: string;
  op: "same" | "add" | "del";
}

function tokenize(s: string): string[] {
  return s.match(/[\u3400-\u9fff\uf900-\ufaff]|[A-Za-z0-9_'-]+|\s+|[^\sA-Za-z0-9_\u3400-\u9fff]/g) || [];
}

export function wordDiff(a: string, b: string): DiffSeg[] {
  const A = tokenize(a || "");
  const B = tokenize(b || "");
  if (A.length * B.length > 250000) return [{ t: a, op: "del" }, { t: b, op: "add" }];
  const n = A.length, m = B.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffSeg[] = [];
  const push = (t: string, op: DiffSeg["op"]) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.t += t;
    else out.push({ t, op });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push(A[i], "same"); i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(A[i], "del"); i++;
    } else {
      push(B[j], "add"); j++;
    }
  }
  while (i < n) push(A[i++], "del");
  while (j < m) push(B[j++], "add");
  return out;
}
