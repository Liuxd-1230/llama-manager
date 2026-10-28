import {
  ArrowDownToLine, ArrowUpToLine, Box, ChevronDown, ChevronRight, ChevronUp, Copy, Eye, EyeOff, FileText,
  LayoutGrid, Lock, LockOpen, RectangleHorizontal, RectangleVertical, Trash2, Type, User, Repeat2, Layers3, Group, Ungroup, Link2, Magnet, AlignVerticalSpaceAround,
} from "lucide-react";
import React, { useState } from "react";
import { bodyOf, cameraMoved, estimateBody, projectLayout } from "../lib/camera";
import { boxColor, expandGroups, groupNumbers, itemName, snap16, wholeGroup } from "../lib/doc";
import {
  alignGroup, bringIntoFrame, commit, duplicateItems, editLayout, groupSelection, moveItemTo, removeItems, reorder, select, setCanvasSize, ungroupSelection,
  updateItem, useStore, useWorkState } from "../store";
import type { Anchor, CanvasKind, DepthTier, ItemLabel, LayoutItem } from "../types";
import { ANCHOR_TEXT, DEPTH_TEXT, LABEL_TEXT, RESOLUTIONS } from "../types";
import { AutoTextarea, Dial, MenuItem, NumField, Popover, Seg, Switch, cx, useAnchor } from "../../../components/kit";

const LABEL_ICON: Record<ItemLabel, React.ReactNode> = {
  object: <Box size={12} />, character: <User size={12} />, text: <Type size={12} />,
};

function Section(p: { title: string; right?: React.ReactNode; children: React.ReactNode; id: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(() => localStorage.getItem(`sec:${p.id}`) !== "0");
  return (
    <div className="section">
      <div className="section-head">
        <button type="button" className="sec-toggle" onClick={() => { setOpen(!open); localStorage.setItem(`sec:${p.id}`, open ? "0" : "1"); }}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="section-title">{p.title}</span>
        </button>
        <div className="spacer" />
        {p.right}
      </div>
      {open && p.children}
    </div>
  );
}

function CanvasSize() {
  const L = useStore((s) => s.doc!.layout);
  const m = useAnchor();
  const portrait = L.height > L.width;
  return (
    <div className="row canvas-size">
      <button ref={m.ref} type="button" className="btn btn-sm grow size-btn" onClick={m.toggle} title="分辨率预设">
        {portrait ? <RectangleVertical size={13} /> : <RectangleHorizontal size={13} />}
        <span className="num">{L.width} × {L.height}</span>
        <ChevronDown size={12} className="muted" />
      </button>
      <Popover anchor={m.ref.current} open={m.open} onClose={m.close} width={220}>
        <div className="menu-label">分辨率（框会等比适配并居中）</div>
        {RESOLUTIONS.map((r) => (
          <MenuItem key={r.name} active={r.width === L.width && r.height === L.height} meta={<span className="num">{r.width}×{r.height}</span>}
            onClick={() => { m.close(); setCanvasSize(r.width, r.height); }}>
            {r.name}
          </MenuItem>
        ))}
      </Popover>
      <button type="button" className="btn btn-sm btn-icon" title="横竖对调（框等比适配）" onClick={() => setCanvasSize(L.height, L.width)}>
        <Repeat2 size={14} />
      </button>
      <NumField label="宽" width={70} value={L.width} onChange={(v) => setCanvasSize(snap16(v), L.height)} />
      <NumField label="高" width={70} value={L.height} onChange={(v) => setCanvasSize(L.width, snap16(v))} />
    </div>
  );
}

function PageSection() {
  const doc = useStore((s) => s.doc!);
  const L = doc.layout;
  const po = L.prompt_options || { depth: true, perspective: false, camera: true, lighting: true };
  const setKind = (k: "layout" | "caption") => commit({ ...doc, kind: k });
  return (
    <Section id="page" title="页面">
      {doc.kind === "layout" ? (
        <>
          <div className="field">
            <label>画布</label>
            <CanvasSize />
          </div>
          <div className="field">
            <label>整体描述 <span className="spacer" /><span className="muted num">{L.summary.caption.length}</span></label>
            <AutoTextarea className="textarea" minRows={4} maxRows={16} value={L.summary.caption}
              placeholder="整张图的场景、氛围、画风、光线……"
              onChange={(e) => editLayout((d) => ({ ...d, summary: { ...d.summary, caption: e.target.value } }), "summary")} />
          </div>
          <div className="field">
            <label>画面类型</label>
            <Seg full small value={(L.summary.canvas || "single") as CanvasKind}
              onChange={(v) => editLayout((d) => ({ ...d, summary: { ...d.summary, canvas: v } }))}
              options={[{ v: "single", t: "单幅" }, { v: "multi_panel", t: "多格分镜" }, { v: "collage", t: "拼贴" }]} />
          </div>
          <div className="field">
            <label>风格标签</label>
            <input className="input" placeholder="逗号分隔，例如 anime, soft light"
              value={(L.summary.meta || []).join(", ")}
              onChange={(e) => editLayout((d) => ({ ...d, summary: { ...d.summary, meta: e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) } }), "meta")} />
          </div>
          <div className="field opts">
            <label className="opt-row" title="根据图层顺序和重叠，给各框追加前后遮挡关系">
              <Switch checked={po.depth} onChange={(v) => editLayout((d) => ({ ...d, prompt_options: { ...po, depth: v } }))} />写入前后关系
            </label>
            <label className="opt-row" title="摄像机开启时，把镜头语言追加到整体描述">
              <Switch checked={po.camera} onChange={(v) => editLayout((d) => ({ ...d, prompt_options: { ...po, camera: v } }))} />写入镜头语言
            </label>
            <label className="opt-row" title="灯光开启时（镜头调度 → 灯光），把灯光描述追加到整体描述">
              <Switch checked={po.lighting !== false} onChange={(v) => editLayout((d) => ({ ...d, prompt_options: { ...po, lighting: v } }))} />写入灯光描述
              {!L.lighting?.enabled && <span className="hint">（灯光未开启）</span>}
            </label>
          </div>
        </>
      ) : (
        <p className="hint">Caption 页在中间直接写散文。也可以让 Agent 根据同系列的 Layout 页写一段 Caption。</p>
      )}
    </Section>
  );
}

function LayerRow({ it, i, selected, groupNo, onDragStart, onDrop }: {
  it: LayoutItem; i: number; selected: boolean; groupNo?: number; onDragStart: () => void; onDrop: () => void;
}) {
  const [edit, setEdit] = useState<string | null>(null);
  const sel = useStore((s) => s.selection);
  return (
    <div
      className={cx("layer", selected && "sel", it.hidden && "is-hidden")}
      draggable={edit === null}
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onClick={(e) => select(e.shiftKey || e.ctrlKey || e.metaKey ? (selected ? sel.filter((x) => x !== it.id) : [...sel, it.id]) : [it.id])}
      onDoubleClick={() => setEdit(it.name || "")}
    >
      <span className="dot" style={{ background: boxColor(it, i) }} />
      <span className="layer-ic">{LABEL_ICON[it.label]}</span>
      {edit === null ? (
        <span className="layer-name ellipsis">{itemName(it, i)}</span>
      ) : (
        <input className="input input-sm grow" autoFocus value={edit} placeholder="名称（只用于编辑和描述引用）"
          onClick={(e) => e.stopPropagation()} onChange={(e) => setEdit(e.target.value)}
          onBlur={() => { updateItem(it.id, { name: edit.trim() || undefined }); setEdit(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEdit(null); }} />
      )}
      {it.group && groupNo !== undefined && (
        <button type="button" className="layer-grp" title={`组 ${groupNo}：点这里选中整组`}
          onClick={(e) => { e.stopPropagation(); select(expandGroups(useStore.getState().doc!.layout.items, [it.id])); }}>
          <Link2 size={10} />{groupNo}
        </button>
      )}
      {it.depth && it.depth !== "auto" && <span className="badge">{DEPTH_TEXT[it.depth]}</span>}
      <button type="button" className="icon-toggle" title={it.hidden ? "显示" : "隐藏（不参与编译）"} onClick={(e) => { e.stopPropagation(); updateItem(it.id, { hidden: !it.hidden }); }}>
        {it.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
      <button type="button" className={cx("icon-toggle", it.locked && "on")} title={it.locked ? "解锁" : "锁定（Agent 也不能改）"} onClick={(e) => { e.stopPropagation(); updateItem(it.id, { locked: !it.locked }); }}>
        {it.locked ? <Lock size={13} /> : <LockOpen size={13} />}
      </button>
    </div>
  );
}

function LayersSection() {
  const s = useWorkState();
  const L = s.doc!.layout;
  const [dragId, setDragId] = useState<string | null>(null);
  const rows = L.items.map((it, i) => ({ it, i })).reverse();
  const any = s.selection.length > 0;
  const groupNo = groupNumbers(L.items);
  const canGroup = expandGroups(L.items, s.selection).length >= 2 && !wholeGroup(L.items, s.selection);
  const canUngroup = L.items.some((x) => x.group && s.selection.includes(x.id));
  return (
    <Section id="layers" title={`图层 · ${L.items.length}`} right={
      <div className="row" style={{ gap: 2 }}>
        <button type="button" className="btn btn-ghost btn-xs btn-icon" disabled={!canGroup} title="成组 Ctrl+G：移动、转镜头时整组一起动（如人物和手里的道具）" onClick={groupSelection}><Group size={13} /></button>
        <button type="button" className="btn btn-ghost btn-xs btn-icon" disabled={!canUngroup} title="解组 Ctrl+Shift+G" onClick={ungroupSelection}><Ungroup size={13} /></button>
        <span className="bar-sep" style={{ height: 14 }} />
        <button type="button" className="btn btn-ghost btn-xs btn-icon" disabled={!any} title="置顶（最前） Shift+]" onClick={() => reorder(s.selection, "top")}><ArrowUpToLine size={12} /></button>
        <button type="button" className="btn btn-ghost btn-xs btn-icon" disabled={!any} title="上移一层 ]" onClick={() => reorder(s.selection, "up")}><ChevronUp size={13} /></button>
        <button type="button" className="btn btn-ghost btn-xs btn-icon" disabled={!any} title="下移一层 [" onClick={() => reorder(s.selection, "down")}><ChevronDown size={13} /></button>
        <button type="button" className="btn btn-ghost btn-xs btn-icon" disabled={!any} title="置底（最后） Shift+[" onClick={() => reorder(s.selection, "bottom")}><ArrowDownToLine size={12} /></button>
      </div>
    }>
      {rows.length ? (
        <div className="layers">
          <div className="layers-hint"><span>前（离镜头近）</span></div>
          {rows.map(({ it, i }) => (
            <LayerRow key={it.id} it={it} i={i} selected={s.selection.includes(it.id)} groupNo={it.group ? groupNo.get(it.group) : undefined}
              onDragStart={() => setDragId(it.id)}
              onDrop={() => { if (dragId && dragId !== it.id) moveItemTo(dragId, i); setDragId(null); }} />
          ))}
          <div className="layers-hint"><span>后（背景）</span></div>
        </div>
      ) : (
        <div className="empty">还没有框。用工具条的「画框」或按 <kbd>B</kbd>。</div>
      )}
    </Section>
  );
}

function Inspector() {
  const s = useWorkState();
  const L = s.doc!.layout;
  const items = L.items.filter((x) => s.selection.includes(x.id));
  if (!items.length) return null;
  if (items.length > 1) {
    const gid = wholeGroup(L.items, s.selection);
    const gno = gid ? groupNumbers(L.items).get(gid) : undefined;
    return (
      <Section id="insp" title={gid ? `组 ${gno} · ${items.length} 个框` : `已选 ${items.length} 个框`}>
        <div className="row wrap">
          {gid ? (
            <>
              <button type="button" className="btn btn-sm" onClick={ungroupSelection} title="Ctrl+Shift+G"><Ungroup size={13} />解组</button>
              <button type="button" className="btn btn-sm" onClick={() => alignGroup(s.selection)} title="和组里更大的成员重叠的框（手持物、贴身道具），远近对齐到它，转镜头时不再分开">
                <AlignVerticalSpaceAround size={13} />对齐远近
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-sm" onClick={groupSelection} title="Ctrl+G：移动、转镜头时整组一起动"><Group size={13} />成组</button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => duplicateItems(s.selection)}><Copy size={13} />复制</button>
          <button type="button" className="btn btn-sm" onClick={() => items.forEach((it) => updateItem(it.id, { hidden: !items[0].hidden }))}><EyeOff size={13} />显隐</button>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => removeItems(s.selection)}><Trash2 size={13} />删除</button>
        </div>
        {gid && (
          <>
            <div className="grp-members">
              {items.map((it) => {
                const k = L.items.indexOf(it);
                return (
                  <button key={it.id} type="button" className="grp-member" onClick={() => select([it.id])} title="只选这一个，编辑它的描述和体块">
                    <span className="dot" style={{ background: boxColor(it, k) }} />{LABEL_ICON[it.label]}<span className="ellipsis">{itemName(it, k)}</span>
                  </button>
                );
              })}
            </div>
            <p className="hint">移动、转镜头时整组一起动。点上面的成员（或在画布上双击）单独编辑；按住 Alt 拖动可组内微调。</p>
          </>
        )}
      </Section>
    );
  }
  const it = items[0];
  const i = L.items.indexOf(it);
  const body = bodyOf(it, L);
  const est = !it.body;
  const ro = it.locked;
  const setBody = (patch: Partial<typeof body>, key: string) => updateItem(it.id, { body: { ...body, ...patch } }, key);
  const [x1, y1, x2, y2] = it.bbox;
  const mates = it.group ? L.items.filter((x) => x.group === it.group && x.id !== it.id) : [];
  const pr = cameraMoved(L) && body.anchor === "world" && !it.hidden ? projectLayout(L).items[it.id] : null;
  const offFrame = !!pr && (!pr.visible || pr.partial);
  return (
    <Section id="insp" title="属性" right={
      <div className="row" style={{ gap: 2 }}>
        <button type="button" className="btn btn-ghost btn-xs btn-icon" title="复制 Ctrl+D" onClick={() => duplicateItems([it.id])}><Copy size={12} /></button>
        <button type="button" className="btn btn-ghost btn-xs btn-icon btn-danger" title="删除 Del" disabled={ro} onClick={() => removeItems([it.id])}><Trash2 size={12} /></button>
      </div>
    }>
      {ro && <div className="locked-note"><Lock size={12} />已锁定：解锁后才能修改</div>}
      {it.group && (
        <div className="grp-note">
          <Link2 size={12} />
          <span className="ellipsis">组 {groupNumbers(L.items).get(it.group)} · 和{mates.slice(0, 2).map((m) => `「${itemName(m, L.items.indexOf(m))}」`).join("")}{mates.length > 2 ? ` 等 ${mates.length} 个` : ""}一起动</span>
          <div className="spacer" />
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => select(expandGroups(L.items, [it.id]))}>选中整组</button>
        </div>
      )}
      <fieldset className="insp" disabled={ro}>
        <div className="field">
          <Seg full small value={it.label} onChange={(v) => updateItem(it.id, { label: v, ...(v === "text" && !it.text ? { text: "" } : {}) })}
            options={(["object", "character", "text"] as ItemLabel[]).map((l) => ({ v: l, t: <>{LABEL_ICON[l]}{LABEL_TEXT[l]}</> }))} />
        </div>
        <div className="field">
          <label>名称</label>
          <input className="input" value={it.name || ""} placeholder={itemName(it, i)} onChange={(e) => updateItem(it.id, { name: e.target.value || undefined }, `name-${it.id}`)} />
        </div>
        {it.label === "text" && (
          <div className="field">
            <label>画面文字（原样出现在图里）</label>
            <input className="input" value={it.text || ""} placeholder="例如：黄昏" onChange={(e) => updateItem(it.id, { text: e.target.value }, `text-${it.id}`)} />
          </div>
        )}
        <div className="field">
          <label>描述 <span className="spacer" /><span className="muted num">{it.caption.length}</span></label>
          <AutoTextarea id="insp-caption" className="textarea" minRows={3} maxRows={9} value={it.caption}
            placeholder={it.label === "text" ? "字体、颜色、排版、材质……" : "外观、材质、姿态、动作……"}
            onChange={(e) => updateItem(it.id, { caption: e.target.value }, `cap-${it.id}`)} />
        </div>
        <div className="field">
          <label>景深层</label>
          <Seg full small value={(it.depth || "auto") as DepthTier} onChange={(v) => updateItem(it.id, { depth: v })}
            options={(["auto", "fg", "mg", "bg"] as DepthTier[]).map((d) => ({ v: d, t: DEPTH_TEXT[d] }))} />
        </div>
        <div className="field">
          <label>位置与尺寸</label>
          <div className="xywh">
            <NumField label="X" value={x1} onChange={(v) => updateItem(it.id, { bbox: [v, y1, v + (x2 - x1), y2] })} />
            <NumField label="Y" value={y1} onChange={(v) => updateItem(it.id, { bbox: [x1, v, x2, v + (y2 - y1)] })} />
            <NumField label="W" value={x2 - x1} onChange={(v) => updateItem(it.id, { bbox: [x1, y1, x1 + Math.max(8, v), y2] })} />
            <NumField label="H" value={y2 - y1} onChange={(v) => updateItem(it.id, { bbox: [x1, y1, x2, y1 + Math.max(8, v)] })} />
          </div>
        </div>
        <div className="body-box">
          <div className="row">
            <Layers3 size={13} className="warm-text" />
            <span className="section-title">3D 体块</span>
            {est && <span className="chip" title="还没手动设置，使用按位置估算的值">估算</span>}
            <div className="spacer" />
            {!est && <button type="button" className="btn btn-ghost btn-xs" onClick={() => updateItem(it.id, { body: estimateBody(it, L.width, L.height, L.perspective?.enabled ? L.perspective.horizon_y : undefined, L.items) })}>重新估算</button>}
          </div>
          {offFrame && (
            <div className="off-note">
              <span className="warm-text">{pr!.visible ? "部分出画" : pr!.corners ? "在当前镜头的画外" : "在镜头后面"}</span>
              <div className="spacer" />
              <button type="button" className="btn btn-xs btn-warm" onClick={() => bringIntoFrame(it.id)} title="镜头不动，把它（连同同组的框）挪回画面里">
                <Magnet size={11} />拉回画面
              </button>
            </div>
          )}
          <Seg full small value={body.anchor} onChange={(v: Anchor) => setBody({ anchor: v }, "")}
            options={(["world", "screen", "backdrop"] as Anchor[]).map((a) => ({
              v: a, t: ANCHOR_TEXT[a],
              title: a === "world" ? "场景里的物体，随机位投影" : a === "screen" ? "贴在屏幕上（标题、字幕），不随机位变化" : "无穷远的背景板（天空、远景），不随机位变化",
            }))} />
          {body.anchor === "world" && (
            <div className="col" style={{ gap: 2, marginTop: 6 }}>
              <Dial warm label="远近" value={body.z} min={0.15} max={12} step={0.01} log digits={2} zero={1} unit="×" title="相对基准深度：1 = 主体平面，越大越远"
                onChange={(v) => setBody({ z: v }, `z-${it.id}`)} />
              <Dial warm label="厚度" value={body.thickness} min={0} max={3} step={0.01} digits={2} title="前后厚度（相对框宽）"
                onChange={(v) => setBody({ thickness: v }, `t-${it.id}`)} />
              <Dial warm label="朝向" value={body.yaw} min={-180} max={180} step={1} unit="°" title="0 = 正对初始机位；正值转向右侧"
                onChange={(v) => setBody({ yaw: v }, `y-${it.id}`)} />
            </div>
          )}
        </div>
      </fieldset>
    </Section>
  );
}

export function DocPanel() {
  const doc = useStore((s) => s.doc);
  if (!doc) return <aside className="panel left" />;
  return (
    <aside className="panel left">
      <div className="panel-body">
        <PageSection />
        {doc.kind === "layout" && (
          <>
            <LayersSection />
            <Inspector />
          </>
        )}
      </div>
    </aside>
  );
}
