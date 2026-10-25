/**
 * 镜头调度室右侧的「灯光」「体块」分页。
 */
import { Box, ChevronDown, Eye, Lightbulb, Magnet, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { bodyMetrics, bodyOf, moveTargets, resizeBody, sceneData, sceneMeter, translateItems, wrapDeg } from "../lib/camera";
import { boxColor, itemName } from "../lib/doc";
import {
  KELVIN_STEPS, LIGHT_EXTRAS, LIGHT_PRESETS, LIGHT_SWATCHES, ROLES, ROLE_ORDER, fromRel, kelvinHex, kelvinRgb, lightRgb, lightingPhrase, newLight,
  normalizeLighting, paintLitSphere, presetById, presetMatches, presetRel, relDir, relLights, rgbHex, type RGB,
} from "../lib/lighting";
import {
  DEFAULT_QUICK, applyLightingPreset, applyMove, bringIntoFrame, editLayout, reestimateBodies, select, send, setLighting, setLightingFollow, toast,
  updateItem, useStore,
} from "../store";
import type { Anchor, Camera, LayoutDraft, Light, LightRole, Lighting } from "../types";
import { LABEL_TEXT } from "../types";
import { Dial, MenuItem, Popover, Seg, Switch, cx, useAnchor } from "../../../components/kit";

// ---------------- 被灯照亮的球 ----------------
type Rel = ReturnType<typeof relLights>[number] | ReturnType<typeof presetRel>[number];

export function LitSphere({ rel, ambient, ambientRgb, size, bg = "#00000000", className }: {
  rel: Rel[]; ambient: number; ambientRgb: RGB; size: number; bg?: string; className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const key = JSON.stringify([rel.map((r) => [r.side, r.up, r.front, r.rgb, r.intensity, r.softness, r.role]), ambient, ambientRgb, size, bg]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(size * dpr);
    c.width = px;
    c.height = px;
    const ctx = c.getContext("2d");
    if (ctx) paintLitSphere(ctx, px, rel, ambient, ambientRgb, bg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <canvas ref={ref} className={className} style={{ width: size, height: size }} />;
}

/** 灯光球：从镜头看主体，手柄 = 灯的方向，可拖动；拖过边缘转到背面 */
function LightBall({ lg, cam, active, onActive, size = 172 }: {
  lg: Lighting; cam: Camera; active: string | null; onActive: (id: string) => void; size?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rel = relLights(lg, cam);
  const R = size / 2 - 1;
  const onDown = (e: React.PointerEvent, l: Light) => {
    e.preventDefault();
    e.stopPropagation();
    onActive(l.id);
    const el = ref.current!;
    el.setPointerCapture(e.pointerId);
    const s0 = relDir(l, lg, cam).front >= 0 ? 1 : -1;
    const key = `ball${Date.now()}`;
    const mv = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = (ev.clientX - r.left - r.width / 2) / R, y = -(ev.clientY - r.top - r.height / 2) / R;
      const rr = Math.hypot(x, y);
      let side = x, up = y, front: number;
      if (rr <= 1) front = s0 * Math.sqrt(Math.max(0, 1 - rr * rr));
      else {
        const r2 = Math.max(0, 2 - rr);
        side = (x / rr) * r2;
        up = (y / rr) * r2;
        front = -s0 * Math.sqrt(Math.max(0, 1 - r2 * r2));
      }
      const a = fromRel(side, up, front, lg, cam);
      setLighting((cur) => ({ preset: "", lights: cur.lights.map((x2) => (x2.id === l.id ? { ...x2, ...a } : x2)) }), key);
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
  return (
    <div ref={ref} className="lt-ball" style={{ width: size, height: size }}>
      <LitSphere rel={rel} ambient={lg.ambient} ambientRgb={kelvinRgb(lg.ambient_kelvin)} size={size} bg="#2b2824" className="lt-ball-canvas" />
      <svg className="lt-ball-svg" width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={R} className="lt-ball-rim" />
        <line x1={size / 2} x2={size / 2} y1={4} y2={size - 4} className="lt-ball-axis" />
        <line y1={size / 2} y2={size / 2} x1={4} x2={size - 4} className="lt-ball-axis" />
        {lg.lights.map((l) => {
          const r = relDir(l, lg, cam);
          const x = size / 2 + r.side * R, y = size / 2 - r.up * R;
          const back = r.front < 0;
          const col = rgbHex(lightRgb(l));
          return (
            <g key={l.id} className={cx("lt-h", active === l.id && "on", !l.enabled && "off", back && "back")} transform={`translate(${x} ${y})`}
              onPointerDown={(e) => onDown(e, l)}>
              <circle r={12} className="lt-h-hit" />
              <circle r={8} fill={back ? "transparent" : col} stroke={back ? col : undefined} />
              <text y={3.5} textAnchor="middle">{ROLES[l.role].short}</text>
            </g>
          );
        })}
      </svg>
      <span className="lt-ball-tag t">上</span>
      <span className="lt-ball-tag l">左</span>
      <span className="lt-ball-tag r">右</span>
    </div>
  );
}

const toStoredAz = (h: number, lg: Lighting, cam: Camera) => Math.round(wrapDeg(h + (lg.follow || !cam.enabled ? 0 : cam.orbit)) * 10) / 10;

function LightRow({ l, lg, cam, open, onOpen }: { l: Light; lg: Lighting; cam: Camera; open: boolean; onOpen: () => void }) {
  const rm = useAnchor();
  const upd = (p: Partial<Light>, key = `light-${l.id}-${Object.keys(p).join()}`) =>
    setLighting((cur) => ({ preset: "", lights: cur.lights.map((x) => (x.id === l.id ? { ...x, ...p } : x)) }), key);
  const col = rgbHex(lightRgb(l));
  const r = relDir(l, lg, cam);
  return (
    <div className={cx("lt-row", open && "open", !l.enabled && "off")}>
      <div className="lt-row-head" onClick={onOpen}>
        <span className="lt-dot" style={{ background: col }} />
        <button ref={rm.ref} type="button" className="btn btn-ghost btn-xs lt-role" onClick={(e) => { e.stopPropagation(); rm.toggle(); }}>
          {ROLES[l.role].zh}<ChevronDown size={10} />
        </button>
        <Popover anchor={rm.ref.current} open={rm.open} onClose={rm.close} width={150}>
          {ROLE_ORDER.map((ro) => (
            <MenuItem key={ro} active={ro === l.role} onClick={() => { rm.close(); upd({ role: ro }, ""); }}>{ROLES[ro].zh}</MenuItem>
          ))}
        </Popover>
        <span className="muted ellipsis lt-row-meta num">{Math.round(r.h)}° · {Math.round(l.elevation)}° · {l.kelvin !== null ? `${l.kelvin}K` : l.color}</span>
        <div className="spacer" />
        <span onClick={(e) => e.stopPropagation()}><Switch warm checked={l.enabled} onChange={(v) => upd({ enabled: v }, "")} title={l.enabled ? "关掉这盏灯" : "打开这盏灯"} /></span>
        <button type="button" className="btn btn-ghost btn-xs btn-icon" title="删除这盏灯"
          onClick={(e) => { e.stopPropagation(); setLighting((cur) => ({ preset: "", lights: cur.lights.filter((x) => x.id !== l.id) }), ""); }}><Trash2 size={12} /></button>
        <ChevronDown size={12} className={cx("lt-caret", open && "on")} />
      </div>
      {open && (
        <div className="lt-row-body">
          <Dial warm label="方位" title="相对镜头：0° 正面，负 = 画面左侧，正 = 右侧，±180° 背后" value={Math.round(r.h)} min={-180} max={180} step={1} unit="°" zero={0}
            onChange={(v) => upd({ azimuth: toStoredAz(v, lg, cam) }, `light-${l.id}-az`)} />
          <Dial warm label="高度" title="正 = 从上往下照，0 = 平射，负 = 底光" value={l.elevation} min={-89} max={89} step={1} unit="°" zero={0}
            onChange={(v) => upd({ elevation: v }, `light-${l.id}-el`)} />
          <Dial warm label="强度" value={l.intensity} min={0} max={2} step={0.05} digits={2} zero={0}
            onChange={(v) => upd({ intensity: v }, `light-${l.id}-in`)} onReset={() => upd({ intensity: 1 }, "")} />
          <Dial warm label="软硬" title="0 = 硬光（阴影边缘清晰），1 = 柔光" value={l.softness} min={0} max={1} step={0.05} digits={2} zero={0}
            onChange={(v) => upd({ softness: v }, `light-${l.id}-soft`)} />
          <div className="lt-colors">
            <span className="muted lt-colors-lbl">色温</span>
            {KELVIN_STEPS.map((k) => (
              <button key={k} type="button" className={cx("lt-sw", l.kelvin === k && "on")} style={{ background: kelvinHex(k) }} title={`${k}K`} onClick={() => upd({ kelvin: k }, "")} />
            ))}
          </div>
          {l.kelvin !== null && (
            <Dial warm label="色温" value={l.kelvin} min={1500} max={12000} step={100} unit="K" log zero={6500}
              onChange={(v) => upd({ kelvin: v }, `light-${l.id}-k`)} onReset={() => upd({ kelvin: 5600 }, "")} />
          )}
          <div className="lt-colors">
            <span className="muted lt-colors-lbl">彩色</span>
            {LIGHT_SWATCHES.map((c) => (
              <button key={c} type="button" className={cx("lt-sw", l.kelvin === null && l.color === c && "on")} style={{ background: c }} title={c} onClick={() => upd({ kelvin: null, color: c }, "")} />
            ))}
            <label className="lt-sw lt-sw-pick" title="自定义颜色">
              <input type="color" value={l.color} onChange={(e) => upd({ kelvin: null, color: e.target.value }, `light-${l.id}-c`)} />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

export function LightingPanel({ L, cam, active, setActive, onSent }: {
  L: LayoutDraft; cam: Camera; active: string | null; setActive: (id: string | null) => void; onSent: () => void;
}) {
  const lg = useMemo(() => normalizeLighting(L.lighting), [L.lighting]);
  const addM = useAnchor();
  const [showEn, setShowEn] = useState(false);
  const po = L.prompt_options;
  const writeOn = po?.lighting !== false;
  const phraseEn = lightingPhrase(lg, cam, false);
  const phraseZh = lightingPhrase(lg, cam, true);
  const matched = lg.preset ? presetMatches(lg, cam) : true;
  const cur = lg.preset ? presetById(lg.preset) : undefined;
  const openId = active && lg.lights.some((l) => l.id === active) ? active : null;
  const ambRgb = kelvinRgb(lg.ambient_kelvin);
  const presetTiles = useMemo(() => LIGHT_PRESETS.map((p) => ({ p, rel: presetRel(p), amb: kelvinRgb(p.ambient_kelvin) })), []);
  const addLight = (role: LightRole) => {
    addM.close();
    const l = newLight(role, cam, lg.follow);
    setLighting((c) => ({ enabled: true, preset: "", lights: [...c.lights, l] }), "");
    setActive(l.id);
  };
  const rewrite = () => {
    const q = DEFAULT_QUICK.find((x) => x.id === "q7")!;
    const s = useStore.getState();
    if (s.settings && !s.settings.api_key_set) return toast("先在「设置」里选择提供商，并到主界面配置其密钥", "err");
    send(q.prompt, { quick: q.label });
    onSent();
  };
  return (
    <>
      <section className="dir-sec">
        <div className="dir-sec-head">
          <Lightbulb size={13} className={lg.enabled ? "warm-text" : "muted"} />
          <span className="section-title">灯光</span>
          <Switch warm checked={lg.enabled} onChange={(v) => {
            if (v && !lg.lights.length) applyLightingPreset("natural");
            else setLighting({ enabled: v }, "");
          }} title="编译时把光线方向、色温、氛围写进提示词" />
          <div className="spacer" />
          <Seg small value={lg.follow ? "follow" : "fixed"} onChange={(v) => setLightingFollow(v === "follow")} options={[
            { v: "fixed", t: "固定在场景", title: "灯固定在场景里：转机位时，光从画面的哪边来会跟着变（逆光可能变顺光）" },
            { v: "follow", t: "跟随镜头", title: "灯跟着镜头转：无论机位怎么转，画面里的光向保持不变" },
          ]} />
        </div>
        {!lg.enabled && <div className="lt-off-note">灯光未开启。选一个预设或打开开关，编译时会把光线写进提示词。</div>}
        <div className="lt-cur">
          <span className="muted">当前</span>
          <b>{cur ? cur.name : lg.lights.length ? "自定义" : "未设置"}</b>
          {cur && !matched && <span className="chip warm" title="转机位后主光方向已经和预设不同，描述会按实际方向写">机位已变</span>}
          {cur && <span className="muted ellipsis">{cur.desc}</span>}
        </div>
        <div className="lt-presets">
          {presetTiles.map(({ p, rel, amb }) => (
            <button key={p.id} type="button" className={cx("lt-preset", lg.preset === p.id && "on")} title={`${p.name}：${p.desc}`} onClick={() => { applyLightingPreset(p.id); setActive(null); }}>
              <LitSphere rel={rel} ambient={p.ambient} ambientRgb={amb} size={40} />
              <span className="ellipsis">{p.name}</span>
            </button>
          ))}
        </div>
      </section>

      <section className={cx("dir-sec", !lg.enabled && "lt-dim")}>
        <div className="dir-sec-head">
          <span className="section-title">灯位</span>
          <span className="hint">从镜头看主体；拖手柄改方向</span>
          <div className="spacer" />
          <button ref={addM.ref} type="button" className="btn btn-xs" disabled={lg.lights.length >= 8} onClick={addM.toggle}><Plus size={11} />加灯</button>
          <Popover anchor={addM.ref.current} open={addM.open} onClose={addM.close} width={150} align="right">
            {ROLE_ORDER.map((ro) => <MenuItem key={ro} onClick={() => addLight(ro)}>{ROLES[ro].zh}</MenuItem>)}
          </Popover>
        </div>
        <div className="lt-ball-wrap">
          <LightBall lg={lg} cam={cam} active={openId} onActive={(id) => setActive(id)} />
          <div className="lt-ball-note">
            实心 = 在主体前方（朝镜头一侧）<br />空心 = 在主体后方<br />拖过球的边缘可以转到背面
          </div>
        </div>
        <div className="lt-list">
          {lg.lights.map((l) => (
            <LightRow key={l.id} l={l} lg={lg} cam={cam} open={openId === l.id} onOpen={() => setActive(openId === l.id ? null : l.id)} />
          ))}
          {!lg.lights.length && <div className="empty lt-empty">还没有灯。选一个预设，或点「加灯」。</div>}
        </div>
      </section>

      <section className={cx("dir-sec", !lg.enabled && "lt-dim")}>
        <div className="dir-sec-head"><span className="section-title">环境与氛围</span></div>
        <Dial warm label="环境光" title="整体的补充亮度：低 = 暗调、对比强；高 = 明亮、阴影浅" value={lg.ambient} min={0} max={1} step={0.05} digits={2} zero={0}
          onChange={(v) => setLighting({ ambient: v }, "lt-amb")} />
        <Dial warm label="环境色温" value={lg.ambient_kelvin} min={1500} max={12000} step={100} unit="K" log zero={6500}
          onChange={(v) => setLighting({ ambient_kelvin: v }, "lt-ambk")} />
        <div className="lt-amb-sw" style={{ background: rgbHex(ambRgb.map((c) => c * (0.35 + lg.ambient * 0.65)) as RGB) }} title="环境光颜色" />
        <div className="lt-extras">
          {LIGHT_EXTRAS.map((x) => {
            const on = lg.extras.includes(x.id);
            return (
              <button key={x.id} type="button" className={cx("chip lt-extra", on && "on")} title={x.en}
                onClick={() => setLighting((c) => ({ extras: on ? c.extras.filter((e) => e !== x.id) : [...c.extras, x.id] }), "")}>{x.label}</button>
            );
          })}
        </div>
        <textarea className="input lt-note" rows={2} placeholder="补充描述（原样写进提示词），如：烛光在墙上摇曳" value={lg.note}
          onChange={(e) => setLighting({ note: e.target.value }, "lt-note")} />
      </section>

      <section className="dir-sec">
        <div className="dir-sec-head">
          <span className="section-title">写进提示词</span>
          <Switch warm checked={writeOn} disabled={!lg.enabled} onChange={(v) => editLayout((d) => ({ ...d, prompt_options: { depth: true, perspective: false, camera: true, ...d.prompt_options, lighting: v } }))}
            title="编译时把灯光短语追加到整体描述后面" />
          <div className="spacer" />
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => setShowEn(!showEn)}>{showEn ? "看中文" : "看英文"}</button>
        </div>
        <div className={cx("lt-phrase", (!lg.enabled || !writeOn) && "muted")}>
          {(showEn ? phraseEn : phraseZh) || "（没有灯光描述）"}
        </div>
        <button type="button" className="btn btn-sm btn-warm lt-rewrite" disabled={!lg.enabled || !lg.lights.length} onClick={rewrite}
          title="让 Agent 按当前灯光改写整体描述和各框描述（受光面、阴影、轮廓光）">
          <Sparkles size={13} />按灯光改描述
        </button>
      </section>
    </>
  );
}

// ---------------- 体块 ----------------
function DecField({ label, value, onChange, step = 0.1, digits = 2, unit, disabled, title }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; digits?: number; unit?: string; disabled?: boolean; title?: string;
}) {
  const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(digits) : "—");
  const [v, setV] = useState(fmt(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setV(fmt(value)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [value, focus]);
  const commit = () => {
    const n = parseFloat(v);
    if (Number.isFinite(n) && Math.abs(n - value) > 1e-9) onChange(n);
    else setV(fmt(value));
  };
  return (
    <label className={cx("decfield", disabled && "disabled")} title={title}>
      <span>{label}</span>
      <input className="input input-sm num" value={v} disabled={disabled}
        onFocus={() => setFocus(true)} onBlur={() => { setFocus(false); commit(); }}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const n = (parseFloat(v) || 0) + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            setV(fmt(n));
            onChange(n);
          }
        }} />
      {unit && <em>{unit}</em>}
    </label>
  );
}

export function BodyPanel({ L, cam, selection, onFrame }: { L: LayoutDraft; cam: Camera; selection: string[]; onFrame: (id: string) => void }) {
  const id = selection.find((x) => L.items.some((it) => it.id === x)) || null;
  const k = id ? L.items.findIndex((x) => x.id === id) : -1;
  const it = k >= 0 ? L.items[k] : null;
  const sd = useMemo(() => sceneData(L, cam), [L, cam]);
  const m = sceneMeter(L);
  const hold = useStore((s) => s.moveHold);
  const list = (
    <div className="dir-list bd-list">
      {L.items.map((x, i) => {
        const b = bodyOf(x, L);
        return (
          <button key={x.id} type="button" className={cx("dir-row", selection.includes(x.id) && "sel")} onClick={() => select([x.id])}>
            <span className="dot" style={{ background: boxColor(x, i) }} />
            <span className="bd-no num">{i + 1}</span>
            <span className="ellipsis">{itemName(x, i)}</span>
            <span className="muted dir-row-kind">{LABEL_TEXT[x.label]}</span>
            <span className={cx("dir-st", b.anchor === "world" ? "in" : "fixed")}>{b.anchor === "world" ? `${(b.z).toFixed(2)}×` : b.anchor === "backdrop" ? "背景板" : "贴屏"}</span>
          </button>
        );
      })}
    </div>
  );
  if (!it) {
    return (
      <>
        <section className="dir-sec">
          <div className="dir-sec-head"><Box size={13} className="muted" /><span className="section-title">体块</span></div>
          <div className="lt-off-note">在 3D 场景、画面或下面的列表里点选一个框，就能精确调整它在场景里的位置、尺寸和朝向。</div>
        </section>
        <section className="dir-sec">
          <div className="dir-sec-head"><span className="section-title">全部框</span><div className="spacer" />
            <button type="button" className="btn btn-xs" onClick={reestimateBodies} title="按框在画面里的位置和大小重新估算所有体块的远近、厚度"><RefreshCw size={11} />重新估算</button>
          </div>
          {list}
        </section>
      </>
    );
  }
  const b = bodyOf(it, L);
  const world = b.anchor === "world";
  const mt = world ? bodyMetrics(it, L) : null;
  const si = sd.items.find((x) => x.id === it.id);
  const group = it.group ? L.items.filter((x) => x.group === it.group).length : 0;
  const move = (T: [number, number, number]) => {
    const t = moveTargets(L, [it.id], "free", it.id);
    if (!t.ids.length) return toast(t.pinned ? "锁定的框（或组里有锁定的框）不能移动" : "不能移动");
    const r = translateItems(L, t.ids, T, hold);
    if (!r) return toast("移不到那里（太近或太远）");
    applyMove(r, "");
  };
  const setAnchor = (a: Anchor) => {
    if (a === b.anchor) return;
    updateItem(it.id, { body: { ...b, anchor: a, ...(a === "backdrop" ? { z: Math.max(b.z, 4), thickness: 0 } : {}) } });
  };
  const ground = sd.ground;
  const X = mt ? mt.center[0] / m : 0;
  const Y = mt ? (ground - mt.bottom) / m : 0;
  const Z = mt ? mt.center[2] / m : 0;
  return (
    <>
      <section className="dir-sec">
        <div className="dir-sec-head">
          <span className="dot" style={{ background: boxColor(it, k) }} />
          <span className="bd-no num">{k + 1}</span>
          <span className="section-title ellipsis">{itemName(it, k)}</span>
          <span className="muted">{LABEL_TEXT[it.label]}</span>
          <div className="spacer" />
          {world && <button type="button" className="btn btn-ghost btn-xs btn-icon" title="取景到它（动机位）" onClick={() => onFrame(it.id)}><Eye size={12} /></button>}
          {world && !it.locked && <button type="button" className="btn btn-ghost btn-xs btn-icon" title="拉回画面（镜头不动）" onClick={() => bringIntoFrame(it.id)}><Magnet size={12} /></button>}
        </div>
        <Seg small full value={b.anchor} onChange={setAnchor} options={[
          { v: "world", t: "3D 体块", title: "放在场景里，随机位产生透视、遮挡变化" },
          { v: "backdrop", t: "背景板", title: "很远的背景（天空、街景）：转机位时只平移、不变形" },
          { v: "screen", t: "贴屏", title: "贴在画面上（文字、标志）：不随机位变化" },
        ]} />
        {world && mt ? (
          <>
            <div className="bd-grp-title">位置<span className="muted">单位：米（按画面高度换算）{group > 1 ? ` · 整组 ${group} 个一起移动` : ""}</span></div>
            <div className="bd-grid">
              <DecField label="X" title="左右（正 = 初始机位的右侧）" value={X} unit="m" disabled={!!it.locked} onChange={(v) => move([(v - X) * m, 0, 0])} />
              <DecField label="离地" title="底边离地面的高度（地面 = 主体脚下）" value={Y} unit="m" disabled={!!it.locked} onChange={(v) => move([0, -(v - Y) * m, 0])} />
              <DecField label="Z" title="远近（离初始机位的距离）" value={Z} unit="m" disabled={!!it.locked} onChange={(v) => move([0, 0, (v - Z) * m])} />
            </div>
            <div className="bd-grp-title">尺寸</div>
            <div className="bd-grid">
              <DecField label="宽" value={mt.w / m} unit="m" disabled={!!it.locked} onChange={(v) => v > 0.01 && updateItem(it.id, resizeBody(it, L, { w: v * m }))} />
              <DecField label="高" title="改高度时底边不动" value={mt.h / m} unit="m" disabled={!!it.locked} onChange={(v) => v > 0.01 && updateItem(it.id, resizeBody(it, L, { h: v * m }))} />
              <DecField label="厚" value={mt.t / m} unit="m" disabled={!!it.locked} onChange={(v) => v >= 0 && updateItem(it.id, resizeBody(it, L, { t: v * m }))} />
            </div>
            <Dial warm label="朝向" title="绕竖直轴转：0 = 正对初始机位，正 = 向画面右侧转" value={b.yaw} min={-180} max={180} step={1} unit="°" zero={0}
              disabled={!!it.locked} onChange={(v) => updateItem(it.id, { body: { ...b, yaw: v } }, `bd-yaw-${it.id}`)} onReset={() => updateItem(it.id, { body: { ...b, yaw: 0 } })} />
            <div className="bd-foot muted num">
              远近 {b.z.toFixed(2)}× · 离镜头 {si ? (Math.hypot(...([0, 1, 2].map((i) => si.center[i] - sd.frame.C[i])) as [number, number, number]) / m).toFixed(1) : "—"} m
              {it.locked && " · 已锁定"}
            </div>
          </>
        ) : (
          <div className="lt-off-note">{b.anchor === "backdrop" ? "背景板放在很远处，转机位时只整体平移。要让它参与透视，切到「3D 体块」。" : "贴屏的框固定在画面上，不随机位变化。"}</div>
        )}
      </section>
      <section className="dir-sec">
        <div className="dir-sec-head"><span className="section-title">全部框</span><div className="spacer" />
          <button type="button" className="btn btn-xs" onClick={reestimateBodies} title="按框在画面里的位置和大小重新估算所有体块的远近、厚度"><RefreshCw size={11} />重新估算</button>
        </div>
        {list}
      </section>
    </>
  );
}
