/**
 * 图像反推：上传参考图 → 视觉模型给出整体描述 + 每个元素的定位框（原图归一化坐标）
 * → 直接在图上标注，可勾选 / 拖动 / 缩放 / 新增 / 改描述 → 按适配方式映射到画布写入。
 */
import {
  Box, ClipboardCopy, Download, Eye, EyeOff, FilePlus2, ImageUp, Loader2, Plus, RefreshCw, Sparkles, Trash2, Type, Upload, User,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { BOX_COLORS, clone, snap16 } from "../lib/doc";
import { normalizeLayout } from "../lib/doc";
import { addPage, replaceCurrentDoc, setUi, toast, useStore } from "../store";
import type { BBox, Doc, ItemLabel } from "../types";
import { LABEL_TEXT } from "../types";
import { AutoTextarea, Modal, Seg, cx } from "../../../components/kit";

type NBox = [number, number, number, number];
type Fit = "cover" | "stretch" | "contain";
interface RevItem {
  key: string;
  label: ItemLabel;
  name: string;
  caption: string;
  text?: string;
  box: NBox;
  on: boolean;
  color: number;
  extra?: Record<string, unknown>;
}
interface Prepared {
  blob: Blob;
  url: string;
  w: number;
  h: number;
  name: string;
}

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const LABEL_ICON: Record<ItemLabel, React.ReactNode> = { object: <Box size={11} />, character: <User size={11} />, text: <Type size={11} /> };
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
let keySeq = 1;

/** 统一转成不超过 2048 的 JPEG：EXIF 方向已校正，模型看到的和界面显示的是同一张图 */
async function prepareImage(f: File): Promise<Prepared> {
  const src = URL.createObjectURL(f);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => bad(new Error("无法读取图片"));
      im.src = src;
    });
    const k = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("图片编码失败"))), "image/jpeg", 0.92));
    return { blob, url: URL.createObjectURL(blob), w, h, name: f.name.replace(/\.[^.]+$/, "") || "image" };
  } finally {
    URL.revokeObjectURL(src);
  }
}

/** 原图归一化框 → 画布像素框（裁切 / 拉伸 / 留边） */
function mapBox(b: NBox, iw: number, ih: number, W: number, H: number, fit: Fit): BBox | null {
  let x1: number, y1: number, x2: number, y2: number;
  if (fit === "stretch") {
    [x1, y1, x2, y2] = [b[0] * W, b[1] * H, b[2] * W, b[3] * H];
  } else {
    const s = fit === "cover" ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih);
    const ox = (W - iw * s) / 2, oy = (H - ih * s) / 2;
    [x1, y1, x2, y2] = [ox + b[0] * iw * s, oy + b[1] * ih * s, ox + b[2] * iw * s, oy + b[3] * ih * s];
  }
  const area = Math.max(1, (x2 - x1) * (y2 - y1));
  const cx1 = Math.max(0, x1), cy1 = Math.max(0, y1), cx2 = Math.min(W, x2), cy2 = Math.min(H, y2);
  if (cx2 - cx1 < 6 || cy2 - cy1 < 6 || ((cx2 - cx1) * (cy2 - cy1)) / area < 0.2) return null;
  return [Math.round(cx1), Math.round(cy1), Math.round(cx2), Math.round(cy2)];
}

/** 裁切模式下画布对应原图的哪一块（归一化） */
function cropRegion(iw: number, ih: number, W: number, H: number): NBox {
  const s = Math.max(W / iw, H / ih);
  const vw = W / (iw * s), vh = H / (ih * s);
  return [(1 - vw) / 2, (1 - vh) / 2, (1 + vw) / 2, (1 + vh) / 2];
}

// ---------------- 标注画面 ----------------
type Drag =
  | { kind: "move"; key: string; start: NBox; x: number; y: number }
  | { kind: "resize"; key: string; start: NBox; h: string; x: number; y: number }
  | { kind: "draw"; x0: number; y0: number; x1: number; y1: number };

function AnnotStage(p: {
  img: Prepared;
  items: RevItem[];
  sel: string | null;
  hover: string | null;
  showLabels: boolean;
  crop: NBox | null;
  editable: boolean;
  onSelect: (k: string | null) => void;
  onHover: (k: string | null) => void;
  onChange: (k: string, box: NBox, coalesce?: boolean) => void;
  onAdd: (box: NBox) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 400 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((en) => {
      const r = en[0].contentRect;
      const w = Math.floor(r.width), h = Math.floor(r.height);
      setSize((o) => (o.w === w && o.h === h ? o : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const k = Math.min((size.w - 24) / p.img.w, (size.h - 24) / p.img.h);
  const dw = Math.max(10, Math.floor(p.img.w * k)), dh = Math.max(10, Math.floor(p.img.h * k));
  const norm = (e: { clientX: number; clientY: number }) => {
    const r = layer.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  useEffect(() => {
    if (!drag) return;
    const mv = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const q = norm(e);
      if (d.kind === "draw") return setDrag({ ...d, x1: q.x, y1: q.y });
      const dx = q.x - d.x, dy = q.y - d.y;
      let [x1, y1, x2, y2] = d.start;
      if (d.kind === "move") {
        const mx = Math.max(-x1, Math.min(dx, 1 - x2)), my = Math.max(-y1, Math.min(dy, 1 - y2));
        p.onChange(d.key, [x1 + mx, y1 + my, x2 + mx, y2 + my], true);
      } else {
        if (d.h.includes("w")) x1 = Math.min(x2 - 0.01, x1 + dx);
        if (d.h.includes("e")) x2 = Math.max(x1 + 0.01, x2 + dx);
        if (d.h.includes("n")) y1 = Math.min(y2 - 0.01, y1 + dy);
        if (d.h.includes("s")) y2 = Math.max(y1 + 0.01, y2 + dy);
        p.onChange(d.key, [Math.max(0, x1), Math.max(0, y1), Math.min(1, x2), Math.min(1, y2)], true);
      }
    };
    const up = () => {
      const d = dragRef.current;
      if (d?.kind === "draw") {
        const b: NBox = [Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.max(d.x0, d.x1), Math.max(d.y0, d.y1)];
        if ((b[2] - b[0]) * dw > 8 && (b[3] - b[1]) * dh > 8) p.onAdd(b);
        else p.onSelect(null);
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
  }, [drag?.kind, dw, dh]);

  const shown = p.items.map((it, i) => ({ it, n: i + 1 })).filter((x) => x.it.on || x.it.key === p.sel || x.it.key === p.hover);
  return (
    <div ref={wrap} className="annot-wrap">
      <div ref={layer} className={cx("annot-layer", p.editable && "editable")} style={{ width: dw, height: dh }}
        onPointerDown={(e) => {
          if (!p.editable || e.button !== 0) return;
          const q = norm(e);
          setDrag({ kind: "draw", x0: q.x, y0: q.y, x1: q.x, y1: q.y });
        }}>
        <img src={p.img.url} alt="" draggable={false} />
        {p.crop && (
          <svg className="annot-crop" width={dw} height={dh}>
            <path fillRule="evenodd" d={`M0 0H${dw}V${dh}H0Z M${p.crop[0] * dw} ${p.crop[1] * dh}V${p.crop[3] * dh}H${p.crop[2] * dw}V${p.crop[1] * dh}Z`} />
            <rect x={p.crop[0] * dw} y={p.crop[1] * dh} width={(p.crop[2] - p.crop[0]) * dw} height={(p.crop[3] - p.crop[1]) * dh} />
          </svg>
        )}
        {shown.map(({ it, n }) => {
          const col = BOX_COLORS[it.color % BOX_COLORS.length];
          const on = it.key === p.sel;
          const [x1, y1, x2, y2] = it.box;
          return (
            <div key={it.key} className={cx("abox", on && "sel", p.hover === it.key && "hover", !it.on && "off")}
              style={{ left: x1 * dw, top: y1 * dh, width: (x2 - x1) * dw, height: (y2 - y1) * dh, ["--c" as any]: col }}
              onPointerEnter={() => p.onHover(it.key)} onPointerLeave={() => p.onHover(null)}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                p.onSelect(it.key);
                if (!p.editable) return;
                const q = norm(e);
                setDrag({ kind: "move", key: it.key, start: [...it.box] as NBox, x: q.x, y: q.y });
              }}>
              <div className={cx("abox-tag", y1 * dh < 20 && "inside")}>
                <b className="num">{n}</b>
                {p.showLabels && <span className="ellipsis">{it.name || LABEL_TEXT[it.label]}</span>}
              </div>
              {on && p.editable && HANDLES.map((h) => (
                <div key={h} className={`handle h-${h}`} onPointerDown={(e) => {
                  e.stopPropagation();
                  const q = norm(e);
                  setDrag({ kind: "resize", key: it.key, start: [...it.box] as NBox, h, x: q.x, y: q.y });
                }} />
              ))}
            </div>
          );
        })}
        {drag?.kind === "draw" && (
          <div className="abox drawing" style={{
            left: Math.min(drag.x0, drag.x1) * dw, top: Math.min(drag.y0, drag.y1) * dh,
            width: Math.abs(drag.x1 - drag.x0) * dw, height: Math.abs(drag.y1 - drag.y0) * dh,
          }} />
        )}
      </div>
    </div>
  );
}

// ---------------- 导出标注图 ----------------
async function exportAnnotated(img: Prepared, items: RevItem[], showLabels: boolean) {
  const im = await new Promise<HTMLImageElement>((ok, bad) => {
    const x = new Image();
    x.onload = () => ok(x);
    x.onerror = () => bad(new Error("图片读取失败"));
    x.src = img.url;
  });
  const c = document.createElement("canvas");
  c.width = img.w;
  c.height = img.h;
  const g = c.getContext("2d")!;
  g.drawImage(im, 0, 0);
  const long = Math.max(img.w, img.h);
  const lw = Math.max(2, Math.round(long / 360));
  const fs = Math.max(13, Math.round(long / 52));
  g.font = `600 ${fs}px "Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", sans-serif`;
  g.textBaseline = "middle";
  items.forEach((it, i) => {
    if (!it.on) return;
    const col = BOX_COLORS[it.color % BOX_COLORS.length];
    const [x1, y1, x2, y2] = [it.box[0] * img.w, it.box[1] * img.h, it.box[2] * img.w, it.box[3] * img.h];
    g.strokeStyle = col;
    g.lineWidth = lw;
    g.strokeRect(x1 + lw / 2, y1 + lw / 2, x2 - x1 - lw, y2 - y1 - lw);
    const label = showLabels ? `${i + 1} ${it.name || LABEL_TEXT[it.label]}` : String(i + 1);
    const tw = g.measureText(label).width + fs * 0.8;
    const th = fs * 1.5;
    const ty = y1 - th >= 0 ? y1 - th : y1;
    g.fillStyle = col;
    g.fillRect(x1, ty, Math.min(tw, Math.max(tw, x2 - x1)), th);
    g.fillStyle = "#fff";
    g.fillText(label, x1 + fs * 0.4, ty + th / 2);
  });
  const dataUrl = c.toDataURL("image/png");
  const filename = `${img.name}-标注.png`;
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast("已导出标注图", "ok");
}

// ---------------- 弹窗 ----------------
export function ReverseModal() {
  const doc = useStore((s) => s.doc!);
  const [img, setImg] = useState<Prepared | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"layout" | "caption">(doc.kind);
  const [detail, setDetail] = useState("medium");
  const [sizeMode, setSizeMode] = useState<"image" | "page">("image");
  const [fit, setFit] = useState<Fit>("cover");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Record<string, any> | null>(null);
  const [capLen, setCapLen] = useState<"long" | "medium" | "short">("medium");
  const [items, setItems] = useState<RevItem[]>([]);
  const [summary, setSummary] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [preview, setPreview] = useState<{ text: string; err: string; busy: boolean }>({ text: "", err: "", busy: false });
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (img) URL.revokeObjectURL(img.url); }, [img]);

  const pick = async (f: File) => {
    if (!f.type.startsWith("image/")) return toast("请选择图片文件", "err");
    setLoading(true);
    try {
      const p = await prepareImage(f);
      setImg(p);
      setRes(null);
      setItems([]);
      setSel(null);
    } catch (e) {
      toast(err(e), "err");
    } finally {
      setLoading(false);
    }
  };
  // 粘贴图片
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = Array.from(e.clipboardData?.files || []).find((x) => x.type.startsWith("image/"));
      if (f) void pick(f);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const target = (() => {
    if (sizeMode === "page" || !img) return { w: doc.layout.width, h: doc.layout.height };
    const long = 1536, short = 1024;
    const r = img.w / img.h;
    return r >= 1 ? { w: snap16(Math.min(long * 1.25, short * r)), h: short } : { w: short, h: snap16(Math.min(long * 1.25, short / r)) };
  })();
  const aspectDiff = img ? Math.abs(Math.log(target.w / target.h / (img.w / img.h))) : 0;
  const needFit = aspectDiff > 0.02;
  const fitEff: Fit = needFit ? fit : "stretch";
  const crop = img && needFit && fit === "cover" ? cropRegion(img.w, img.h, target.w, target.h) : null;

  const run = async () => {
    if (!img) return;
    setBusy(true);
    setRes(null);
    try {
      const file = new File([img.blob], `${img.name}.jpg`, { type: "image/jpeg" });
      const r = await api.reverse(file, mode, detail, target.w, target.h, img.w, img.h);
      setRes(r);
      if (r.mode === "layout") {
        const list: RevItem[] = (r.items || []).map((it: any, i: number) => ({
          key: `r${keySeq++}`, label: it.label, name: it.name || "", caption: it.caption || "", text: it.text, box: it.box as NBox,
          on: true, color: i % BOX_COLORS.length,
          extra: Object.fromEntries(Object.entries(it).filter(([k]) => ["tags", "palette"].includes(k))),
        }));
        setItems(list);
        setSummary(r.summary?.caption || "");
        setSel(null);
        if (r.dropped) toast(`有 ${r.dropped} 个元素没给出有效坐标，已忽略`);
      }
    } catch (e) {
      toast("反推失败：" + err(e), "err");
    } finally {
      setBusy(false);
    }
  };

  const mapped = useMemo(() => {
    if (!img) return [];
    return items.map((it) => ({ it, bbox: it.on ? mapBox(it.box, img.w, img.h, target.w, target.h, fitEff) : null }));
  }, [items, img, target.w, target.h, fitEff]);
  const draft = useMemo(() => {
    if (!res || res.mode !== "layout") return null;
    return {
      width: target.w, height: target.h, bbox_coord_space: "abs", bbox_format: "xyxy",
      summary: { ...(res.summary || {}), caption: summary },
      items: mapped.filter((m) => m.bbox).map(({ it, bbox }) => ({
        label: it.label, caption: it.caption || LABEL_TEXT[it.label], name: it.name || undefined, color: it.color, bbox: bbox!,
        ...(it.label === "text" ? { text: it.text || it.caption } : it.text ? { text: it.text } : {}),
        ...(it.extra || {}),
      })),
    };
  }, [res, mapped, summary, target.w, target.h]);

  // 提示词预览（防抖）
  useEffect(() => {
    if (!draft) return;
    if (!draft.items.length) return setPreview({ text: "", err: "至少保留一个框", busy: false });
    setPreview((p) => ({ ...p, busy: true }));
    const t = setTimeout(() => {
      api.compile(draft).then((r) => setPreview({ text: r.prompt, err: "", busy: false }))
        .catch((e) => setPreview({ text: "", err: err(e), busy: false }));
    }, 380);
    return () => clearTimeout(t);
  }, [draft]);

  const patchItem = (k: string, p: Partial<RevItem>) => setItems((xs) => xs.map((x) => (x.key === k ? { ...x, ...p } : x)));
  const addItem = (box: NBox) => {
    const key = `r${keySeq++}`;
    setItems((xs) => [...xs, { key, label: "object", name: "", caption: "", box, on: true, color: xs.length % BOX_COLORS.length }]);
    setSel(key);
  };
  const removeItem = (k: string) => {
    setItems((xs) => xs.filter((x) => x.key !== k));
    if (sel === k) setSel(null);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); removeItem(sel); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const resultDoc = (): Doc | null => {
    if (!res) return null;
    const base = clone(doc);
    if (res.mode === "caption") return { ...base, kind: "caption", caption: { caption: res.caption?.[capLen] || "" } };
    if (!draft || !draft.items.length) return null;
    return { ...base, kind: "layout", layout: normalizeLayout({ ...(draft as any), camera: base.layout.camera && { ...base.layout.camera, enabled: false } }) };
  };
  const promptText = res?.mode === "caption" ? res.caption?.[capLen] || "" : preview.text;
  const copy = async (t: string) => {
    try {
      await navigator.clipboard.writeText(t);
      toast("已复制", "ok");
    } catch {
      toast("复制失败", "err");
    }
  };
  const selItem = items.find((x) => x.key === sel) || null;
  const selIndex = selItem ? items.indexOf(selItem) : -1;
  const isLayout = res?.mode === "layout";
  const onCount = items.filter((x) => x.on).length;
  const cutCount = mapped.filter((m) => m.it.on && !m.bbox).length;

  return (
    <Modal className="studio-root" xl title="图像反推" icon={<ImageUp size={16} />} onClose={() => setUi({ modal: null })}
      head={img && <span className="hint num">原图 {img.w} × {img.h}</span>}
      foot={<>
        <span className="hint">{isLayout ? "拖动框可修正位置；在图上空白处拖拽可新增框；Delete 删除选中框。" : "需要视觉模型；结果先预览，确认后再写入。"}</span>
        <div className="spacer" />
        {isLayout && img && (
          <button type="button" className="btn" disabled={!onCount} onClick={() => void exportAnnotated(img, items, showLabels).catch((e) => toast(err(e), "err"))}>
            <Download size={13} />导出标注图
          </button>
        )}
        <button type="button" className="btn" disabled={!promptText} onClick={() => void copy(promptText)}><ClipboardCopy size={13} />复制提示词</button>
        <button type="button" className="btn" disabled={!res} onClick={async () => { const d = resultDoc(); if (d) { await addPage({ doc: d, name: "反推" }); setUi({ modal: null }); } }}><FilePlus2 size={13} />新建一页</button>
        <button type="button" className="btn btn-primary" disabled={!res} onClick={async () => { const d = resultDoc(); if (d) { await replaceCurrentDoc(d, "reverse", "图像反推"); setUi({ modal: null }); toast("已写入当前页（可撤销）", "ok"); } }}>写入当前页</button>
      </>}>
      <div className="rev">
        <div className={cx("rev-stage", !img && "empty")}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void pick(f); }}>
          {!img ? (
            <button type="button" className="rev-drop" onClick={() => fileInput.current?.click()}>
              {loading ? <Loader2 size={24} className="spin" /> : <Upload size={24} />}
              <span>拖入、粘贴或点击选择参考图</span>
              <span className="hint">识别后会直接在图上标出每个元素的定位框</span>
            </button>
          ) : (
            <>
              <AnnotStage img={img} items={isLayout ? items : []} sel={sel} hover={hover} showLabels={showLabels}
                crop={isLayout ? crop : null} editable={isLayout} onSelect={setSel} onHover={setHover}
                onChange={(k, box) => patchItem(k, { box })} onAdd={addItem} />
              <div className="rev-stage-bar">
                <button type="button" className="btn btn-xs" onClick={() => fileInput.current?.click()}><RefreshCw size={11} />换一张</button>
                {isLayout && (
                  <button type="button" className={cx("btn btn-xs", showLabels && "on")} onClick={() => setShowLabels(!showLabels)}>
                    {showLabels ? <Eye size={11} /> : <EyeOff size={11} />}名称
                  </button>
                )}
                {isLayout && crop && <span className="rev-chip">虚线内 = 画布裁切范围</span>}
                {busy && <span className="rev-chip"><Loader2 size={11} className="spin" />视觉模型正在看图…</span>}
              </div>
            </>
          )}
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ""; }} />
        </div>

        <div className="rev-side">
          <section className="rev-sec">
            <div className="field"><label>反推成</label>
              <Seg full value={mode} onChange={setMode} options={[{ v: "layout", t: "Layout + 定位框" }, { v: "caption", t: "Caption 散文" }]} /></div>
            <div className="field"><label>详细程度</label>
              <Seg full value={detail} onChange={setDetail} options={[{ v: "long", t: "详细" }, { v: "medium", t: "适中" }, { v: "short", t: "简洁" }]} /></div>
            {mode === "layout" && (
              <div className="field"><label>画布 <span className="hint num">{target.w} × {target.h}</span></label>
                <Seg full value={sizeMode} onChange={setSizeMode} options={[{ v: "image", t: "按图片比例" }, { v: "page", t: "当前页尺寸" }]} />
              </div>
            )}
            {mode === "layout" && needFit && (
              <div className="field"><label>比例不同时</label>
                <Seg full value={fit} onChange={setFit} options={[
                  { v: "cover", t: "裁切", title: "铺满画布，超出部分裁掉（图上虚线框）" },
                  { v: "stretch", t: "拉伸", title: "框按比例拉伸到画布" },
                  { v: "contain", t: "留边", title: "完整放进画布，四周留白" },
                ]} />
              </div>
            )}
            <button type="button" className="btn btn-primary rev-run" disabled={!img || busy} onClick={() => void run()}>
              {busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}{busy ? "识别中…" : res ? "重新识别" : "开始反推"}
            </button>
          </section>

          {res?.mode === "caption" && (
            <section className="rev-sec grow">
              <div className="rev-sec-head"><span className="section-title">Caption</span><div className="spacer" />
                <Seg small value={capLen} onChange={setCapLen} options={[{ v: "long", t: "长" }, { v: "medium", t: "中" }, { v: "short", t: "短" }]} /></div>
              <div className="reverse-text">{res.caption?.[capLen]}</div>
            </section>
          )}

          {isLayout && (
            <>
              <section className="rev-sec">
                <div className="rev-sec-head"><span className="section-title">整体描述</span></div>
                <AutoTextarea className="input" minRows={2} maxRows={6} value={summary} onChange={(e) => setSummary(e.target.value)} />
              </section>
              <section className="rev-sec grow">
                <div className="rev-sec-head">
                  <span className="section-title">定位框</span>
                  <span className="hint num">{onCount}/{items.length}{cutCount ? ` · ${cutCount} 个被裁掉` : ""}</span>
                  <div className="spacer" />
                  <button type="button" className="btn btn-xs" onClick={() => addItem([0.35, 0.35, 0.65, 0.65])} title="新增一个框（也可以在图上拖拽）"><Plus size={11} />新增</button>
                </div>
                <div className="rev-list">
                  {mapped.map(({ it, bbox }, i) => (
                    <div key={it.key} className={cx("rev-row", sel === it.key && "sel", hover === it.key && "hover", !it.on && "off")}
                      onMouseEnter={() => setHover(it.key)} onMouseLeave={() => setHover(null)} onClick={() => setSel(it.key)}>
                      <input type="checkbox" checked={it.on} onClick={(e) => e.stopPropagation()} onChange={(e) => patchItem(it.key, { on: e.target.checked })} title="写入时包含这个框" />
                      <span className="rev-num num" style={{ background: BOX_COLORS[it.color % BOX_COLORS.length] }}>{i + 1}</span>
                      {LABEL_ICON[it.label]}
                      <span className="ellipsis rev-name">{it.name || (it.label === "text" ? `“${it.text || ""}”` : LABEL_TEXT[it.label])}</span>
                      <span className="ellipsis hint rev-cap">{it.caption}</span>
                      {it.on && !bbox && <span className="rev-cut">裁掉</span>}
                    </div>
                  ))}
                  {!items.length && <div className="empty">没有识别到元素，可以在图上拖拽手动添加</div>}
                </div>
                {selItem && (
                  <div className="rev-edit">
                    <div className="row">
                      <span className="rev-num num" style={{ background: BOX_COLORS[selItem.color % BOX_COLORS.length] }}>{selIndex + 1}</span>
                      <Seg small value={selItem.label} onChange={(v) => patchItem(selItem.key, { label: v })}
                        options={(["object", "character", "text"] as ItemLabel[]).map((l) => ({ v: l, t: <>{LABEL_ICON[l]}{LABEL_TEXT[l]}</> }))} />
                      <input className="input grow" value={selItem.name} placeholder="名称" onChange={(e) => patchItem(selItem.key, { name: e.target.value })} />
                      <button type="button" className="btn btn-ghost btn-xs btn-icon" onClick={() => removeItem(selItem.key)} title="删除（Delete）"><Trash2 size={12} /></button>
                    </div>
                    {selItem.label === "text" && (
                      <input className="input" value={selItem.text || ""} placeholder="文字内容（原文）" onChange={(e) => patchItem(selItem.key, { text: e.target.value })} />
                    )}
                    <AutoTextarea className="input" minRows={2} maxRows={6} value={selItem.caption} placeholder="英文描述" onChange={(e) => patchItem(selItem.key, { caption: e.target.value })} />
                  </div>
                )}
              </section>
              <section className="rev-sec">
                <div className="rev-sec-head">
                  <span className="section-title">提示词</span>
                  {preview.busy && <Loader2 size={12} className="spin muted" />}
                  <div className="spacer" />
                  <button type="button" className="btn btn-xs" disabled={!preview.text} onClick={() => void copy(preview.text)}><ClipboardCopy size={11} />复制</button>
                </div>
                {preview.err ? <div className="notice err">{preview.err}</div> : <pre className="rev-prompt mono">{preview.text || "…"}</pre>}
              </section>
            </>
          )}
          {!res && (
            <section className="rev-sec grow rev-tips">
              <div className="section-title">说明</div>
              <ul>
                <li>Layout 模式会让视觉模型按原图坐标给出每个元素的定位框，并直接标在左侧图上。</li>
                <li>框不准可以直接拖动 / 拉角修正，空白处拖拽新增，取消勾选的框不会写入。</li>
                <li>画布比例和原图不同时，可选裁切 / 拉伸 / 留边。</li>
                <li>可导出带标注的 PNG。</li>
              </ul>
            </section>
          )}
        </div>
      </div>
    </Modal>
  );
}
