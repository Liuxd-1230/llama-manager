import { Anchor as AnchorIcon, Camera as CameraIcon, ChevronDown, ChevronUp, Clapperboard, Hand, Layers3, MessageSquareText, RotateCcw, Wand2 } from "lucide-react";
import React, { useRef } from "react";
import { CAMERA_LIMITS, CAMERA_PRESETS, bodyOf, cameraMoved, cameraPhraseZh, clampCamera, framingZoom, wrapDeg } from "../lib/camera";
import { defaultCamera } from "../lib/doc";
import { DEFAULT_QUICK, bakeCamera, openDirector, reestimateBodies, resetCamera, send, setCamera, setUi, toggleCamera, useStore, useWorkState } from "../store";
import type { Camera, CameraKey } from "../types";
import { Dial, MenuItem, Popover, Switch, cx, useAnchor } from "../ui";

const EL = (28 * Math.PI) / 180;

export function Gizmo({ cam, subjectYaw, size = 132, onCam = setCamera }: {
  cam: Camera; subjectYaw: number; size?: number; onCam?: (patch: Partial<Camera>, key?: string) => void;
}) {
  const S = 132, c = S / 2, R = 50;
  const ref = useRef<SVGSVGElement>(null);
  const P = (orbit: number, pitch: number, r = R) => {
    const o = (orbit * Math.PI) / 180, p = (pitch * Math.PI) / 180;
    const x = Math.sin(o) * Math.cos(p), y = -Math.sin(p), z = -Math.cos(o) * Math.cos(p);
    return { x: c + r * x, y: c + r * (y * Math.cos(EL) - z * Math.sin(EL)), front: -y * Math.sin(EL) - z * Math.cos(EL) > -0.05 };
  };
  const ring = Array.from({ length: 73 }, (_, i) => P(i * 5 - 180, 0));
  const meridian = Array.from({ length: 35 }, (_, i) => P(cam.orbit, -85 + i * 5));
  const path = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("");
  const camPt = P(cam.orbit, cam.pitch, R * Math.min(1.25, 0.75 + 0.25 * cam.distance));
  const facing = P(subjectYaw, 0, 22);
  const onDown = (e: React.PointerEvent) => {
    const el = ref.current!;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY, o0 = cam.orbit, p0 = cam.pitch;
    const key = `gizmo${Date.now()}`;
    const k = 0.9 * (132 / size);
    const mv = (ev: PointerEvent) => onCam({ orbit: wrapDeg(o0 + (ev.clientX - x0) * k), pitch: p0 - (ev.clientY - y0) * k }, key);
    const up = () => {
      el.removeEventListener("pointermove", mv);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", mv);
    el.addEventListener("pointerup", up);
  };
  return (
    <svg ref={ref} className="gizmo" width={size} height={size} viewBox={`0 0 ${S} ${S}`} onPointerDown={onDown}
      onWheel={(e) => onCam({ distance: cam.distance * (e.deltaY > 0 ? 1.06 : 1 / 1.06) }, "gizmo-wheel")}
      onDoubleClick={() => onCam({ orbit: 0, pitch: 0 }, "")}>
      <defs>
        <radialGradient id="gz-bg" cx="50%" cy="42%" r="60%">
          <stop offset="0" stopColor="#fbfaf7" />
          <stop offset="1" stopColor="#e9e4dc" />
        </radialGradient>
      </defs>
      <circle cx={c} cy={c} r={c - 3} fill="url(#gz-bg)" className="gz-well" />
      <path d={path(ring)} className="gz-ring" />
      <path d={path(meridian)} className="gz-meridian" />
      {/* 地面十字 */}
      <path d={path([P(-90, 0, 14), P(90, 0, 14)])} className="gz-axis" />
      <path d={path([P(0, 0, 14), P(180, 0, 14)])} className="gz-axis" />
      {/* 主体与朝向 */}
      <rect x={c - 6} y={c - 9} width={12} height={14} rx={2.5} className="gz-subject" />
      <line x1={c} y1={c} x2={facing.x} y2={facing.y} className="gz-facing" />
      <circle cx={facing.x} cy={facing.y} r={2} className="gz-facing-dot" />
      {/* 机位 */}
      <line x1={camPt.x} y1={camPt.y} x2={c} y2={c - 2} className={cx("gz-ray", !camPt.front && "back")} />
      <g transform={`translate(${camPt.x} ${camPt.y})`} className={cx("gz-cam", !camPt.front && "back")}>
        <circle r={7.5} />
        <circle r={3} className="gz-lens" />
      </g>
      <text x={c} y={S - 9} className="gz-label">前</text>
    </svg>
  );
}

export const ROWS: { k: CameraKey; label: string; step: number; unit?: string; log?: boolean; digits?: number; zero?: number; title: string }[] = [
  { k: "orbit", label: "环绕", step: 1, unit: "°", title: "绕主体水平转动，正值转到右侧" },
  { k: "pitch", label: "俯仰", step: 1, unit: "°", title: "正值升高俯拍，负值降低仰拍" },
  { k: "roll", label: "滚转", step: 1, unit: "°", title: "镜头倾斜（荷兰角）" },
  { k: "distance", label: "距离", step: 0.01, unit: "×", log: true, digits: 2, zero: 1, title: "相对初始距离，<1 推近，>1 拉远" },
  { k: "fov", label: "视角", step: 1, unit: "°", zero: 50, title: "竖直视场角，50 标准；大=广角，小=长焦" },
  { k: "pan_x", label: "平移 X", step: 0.01, digits: 2, title: "镜头左右平移（相对主体距离）" },
  { k: "pan_y", label: "平移 Y", step: 0.01, digits: 2, title: "镜头上下平移" },
  { k: "pan_z", label: "平移 Z", step: 0.01, digits: 2, title: "镜头前后平移，正值后退" },
];

export function CameraCard() {
  const s = useWorkState();
  const busy = useStore((st) => !!st.streaming);
  const presets = useAnchor();
  const L = s.doc?.layout;
  if (!L || s.doc?.kind !== "layout") return null;
  const cam = clampCamera(L.camera || defaultCamera());
  const moved = cameraMoved(L);
  const stop = (e: React.PointerEvent | React.WheelEvent) => e.stopPropagation();
  if (!s.cameraPanelOpen)
    return (
      <div className="cam-card collapsed" onPointerDown={stop}>
        <button type="button" className="btn btn-sm" onClick={() => setUi({ cameraPanelOpen: true })}>
          <CameraIcon size={14} />摄像机{cam.enabled && <span className="warm-text num">{cameraPhraseZh(cam, L)}</span>}<ChevronUp size={13} />
        </button>
      </div>
    );
  const world = L.items.filter((it) => bodyOf(it, L).anchor === "world");
  const subj = world.find((it) => it.label === "character") || world[0];
  const subjectYaw = subj ? bodyOf(subj, L).yaw : 0;
  return (
    <div className={cx("cam-card", !cam.enabled && "off")} onPointerDown={stop} onWheel={stop}>
      <div className="cam-head">
        <CameraIcon size={14} className="warm-text" />
        <span className="panel-title">摄像机</span>
        <Switch warm on={cam.enabled} onChange={(v) => toggleCamera(v)} title="开启后框变成 3D 体块，按机位实时投影" />
        <div className="spacer" />
        {cam.enabled && (
          <>
            <button ref={presets.ref} type="button" className="btn btn-xs" onClick={presets.toggle}>预设<ChevronDown size={11} /></button>
            <Popover anchor={presets.ref.current} open={presets.open} onClose={presets.close} above width={170}>
              {CAMERA_PRESETS.map((p) => (
                <MenuItem key={p.name} onClick={() => { presets.close(); setCamera({ ...defaultCamera(), ...p.cam, enabled: true }, ""); }}>{p.name}</MenuItem>
              ))}
            </Popover>
            <button type="button" className={cx("btn btn-xs btn-icon", s.freeCam && "on")} onClick={() => setUi({ freeCam: !s.freeCam })} title="自由镜头（Shift+`）"><Hand size={12} /></button>
          </>
        )}
        <button type="button" className="btn btn-xs btn-warm" onClick={openDirector} title="全屏镜头调度：看得到画框外的内容，自动取景（F）"><Clapperboard size={12} />调度</button>
        <button type="button" className="btn btn-ghost btn-xs btn-icon" onClick={() => setUi({ cameraPanelOpen: false })} title="收起"><ChevronDown size={13} /></button>
      </div>
      {!cam.enabled ? (
        <div className="cam-off">
          <p>把框当成 3D 体块，环绕 / 俯仰 / 推拉时实时投影，并写入镜头语言。原框即初始机位，随时可复原。</p>
          <button type="button" className="btn btn-xs btn-warm" onClick={() => toggleCamera(true)}><CameraIcon size={12} />开启</button>
        </div>
      ) : (
        <>
          <div className="cam-body">
            <div className="cam-left">
              <Gizmo cam={cam} subjectYaw={subjectYaw} />
              <div className="cam-readout">
                <span className="num">景别 {framingZoom(cam).toFixed(2)}×</span>
              </div>
            </div>
            <div className="cam-dials">
              {ROWS.map((r) => {
                const [lo, hi] = CAMERA_LIMITS[r.k];
                return (
                  <Dial key={r.k} warm label={r.label} title={r.title} value={cam[r.k]} min={lo} max={hi} step={r.step} unit={r.unit}
                    log={r.log} digits={r.digits} zero={r.zero}
                    onChange={(v) => setCamera({ [r.k]: v } as Partial<Camera>, `dial-${r.k}`)}
                    onReset={() => setCamera({ [r.k]: defaultCamera()[r.k] } as Partial<Camera>)} />
                );
              })}
            </div>
          </div>
          <div className="cam-phrase" title="编译时追加到整体描述的镜头语言">
            <span className="muted">镜头语言</span>
            <span className="ellipsis">{cameraPhraseZh(cam, L)}</span>
          </div>
          <div className="cam-foot">
            <button type="button" className="btn btn-xs" disabled={!moved} onClick={resetCamera} title="回到初始机位（原框）"><RotateCcw size={11} />重置</button>
            <button type="button" className="btn btn-xs" disabled={!moved} onClick={bakeCamera} title="把当前镜头下的框写回原框，机位归零"><AnchorIcon size={11} />定为基准</button>
            <button type="button" className="btn btn-xs" onClick={reestimateBodies} title="按框的位置和大小重新估算每个体块的远近与厚度"><Layers3 size={11} />估算体块</button>
            <div className="spacer" />
            <button type="button" className="btn btn-xs btn-warm" disabled={busy}
              onClick={() => { const q = DEFAULT_QUICK.find((x) => x.id === "q3")!; send(q.prompt, { quick: q.label }); }}
              title="让 Agent 按当前镜头改写整体描述和各框描述">
              <MessageSquareText size={11} />按视角改描述
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export { Wand2 };
