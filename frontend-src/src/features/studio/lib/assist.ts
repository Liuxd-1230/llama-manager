/** 「交给 Agent 补全」：根据当前页状态和用户勾选的项，拼出一条发给 Agent 的请求。 */
import { cameraMoved, cameraPhraseZh } from "./camera";
import { itemName } from "./doc";
import type { Doc, LayoutItem } from "../types";

export interface AssistPrefs {
  /** 补全空白 / 过短的描述 */
  fill: boolean;
  /** 按当前机位写清可见面和透视 */
  camera: boolean;
  /** 统一整体描述与各框 */
  unify: boolean;
  /** 检查文字框、类型 */
  check: boolean;
  /** 只改选中的框 */
  onlySel: boolean;
}

export const ASSIST_DEFAULT: AssistPrefs = { fill: true, camera: true, unify: true, check: true, onlySel: false };
const KEY = "moss.assist.prefs";

export function loadAssistPrefs(): AssistPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...ASSIST_DEFAULT, ...(v && typeof v === "object" ? v : {}) };
  } catch {
    return { ...ASSIST_DEFAULT };
  }
}

export function saveAssistPrefs(p: AssistPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式等 */
  }
}

/** 一个框的描述算“过短”的阈值：中文按字、英文按词 */
function isShort(t: string): boolean {
  const s = t.trim();
  if (!s) return false;
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length;
  if (cjk > s.length * 0.3) return cjk < 12;
  return s.split(/\s+/).filter(Boolean).length < 8;
}

export interface AssistStats {
  kind: "layout" | "caption";
  items: number;
  empty: number;
  short: number;
  textMissing: number;
  summaryLen: number;
  camOn: boolean;
  camMoved: boolean;
  phrase: string;
  captionLen: number;
}

export function assistStats(doc: Doc): AssistStats {
  const L = doc.layout;
  const vis = L.items.filter((x) => !x.hidden);
  const camOn = !!L.camera?.enabled;
  return {
    kind: doc.kind,
    items: vis.length,
    empty: vis.filter((x) => !x.caption.trim()).length,
    short: vis.filter((x) => isShort(x.caption)).length,
    textMissing: vis.filter((x) => x.label === "text" && !(x.text || "").trim()).length,
    summaryLen: (L.summary?.caption || "").trim().length,
    camOn,
    camMoved: cameraMoved(L),
    phrase: camOn && L.camera ? cameraPhraseZh(L.camera, L) : "",
    captionLen: (doc.caption?.caption || "").trim().length,
  };
}

const quote = (xs: LayoutItem[]) => xs.map((x, i) => `「${itemName(x, i)}」`).join("");

/** 生成请求文本。selection 是当前选中的框 id。 */
export function buildAssistPrompt(doc: Doc, prefs: AssistPrefs, selection: string[], note: string): string {
  const extra = note.trim();
  if (doc.kind === "caption") {
    const lines = [
      "我写好了这一页的 Caption，请帮我补全成一段完整、可画的提示词：",
      "- 把含糊的地方写具体：主体外观与动作、环境、光线与色调、镜头与景别。",
      "- 保持我写的主体、数量、关系、风格和排除项不变，只补充、润色，不要推翻重写。",
      "- 用 set_caption 写回当前页。",
    ];
    if (extra) lines.push(`补充要求：${extra}`);
    lines.push("改完用一两句话说明补了什么。");
    return lines.join("\n");
  }
  const L = doc.layout;
  const st = assistStats(doc);
  const picked = prefs.onlySel ? L.items.filter((x) => selection.includes(x.id) && !x.hidden) : [];
  const todo: string[] = [];
  if (prefs.fill)
    todo.push("补全：把整体描述和各框里空的、过短或含糊的描述写成具体、可画的描述（外观、材质、动作、光线）。");
  if (prefs.camera && st.camOn)
    todo.push(`机位：按当前镜头（${st.phrase}）写清每个框能看到哪一面、朝向和透视，整体描述里点明视角与景别。`);
  if (prefs.unify)
    todo.push("统一：整体描述和各框的主体、数量、风格、时间与光线保持一致；每个框只写它自己框里看得见的东西。");
  if (prefs.check)
    todo.push("检查：文字框补上要画出来的文字；描述与类型（角色 / 物体 / 文字）不符的地方改正。");
  if (!todo.length) todo.push("通读当前页，把提示词补充完整。");
  const lines = [
    "我编辑完了这一页（整体描述、框和机位都以 workbench 为准），请帮我补全提示词。",
    "要做的：",
    ...todo.map((t, i) => `${i + 1}. ${t}`),
  ];
  if (picked.length) lines.push(`范围：只改 ${quote(picked)} 这几个框，整体描述只在必要时联动修改。`);
  lines.push(
    "约束：不要移动或缩放框，不要增删框，不要改图层顺序、机位和体块；我手动写好的具体设定保留原意，只补充、润色，不要推翻。用 update_items / update_summary 修改。",
  );
  if (extra) lines.push(`补充要求：${extra}`);
  lines.push("最后用一两句话说明改了哪些地方，不要把整段提示词贴出来。");
  return lines.join("\n");
}
