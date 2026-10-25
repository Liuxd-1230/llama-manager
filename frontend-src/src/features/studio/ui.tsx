import { ChevronLeft, ChevronRight, X } from "lucide-react";
import React, { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function cx(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}

// ---------- 分段控件 ----------
export function Seg<T extends string | number>(p: {
  value: T;
  options: { v: T; t: React.ReactNode; title?: string }[];
  onChange: (v: T) => void;
  small?: boolean;
  full?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className={cx("seg", p.small && "seg-sm", p.full && "full")} role="radiogroup">
      {p.options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          role="radio"
          aria-checked={o.v === p.value}
          title={o.title}
          disabled={p.disabled}
          className={cx(o.v === p.value && "on")}
          onClick={() => p.onChange(o.v)}
        >
          {o.t}
        </button>
      ))}
    </div>
  );
}

export function Switch(p: { on: boolean; onChange: (v: boolean) => void; warm?: boolean; title?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={p.on}
      title={p.title}
      disabled={p.disabled}
      className={cx("switch", p.on && "on", p.warm && "warm")}
      onClick={() => p.onChange(!p.on)}
    />
  );
}

// ---------- 弹出菜单 ----------
export function Popover(p: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  align?: "left" | "right";
  above?: boolean;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!p.open || !p.anchor) return;
    const r = p.anchor.getBoundingClientRect();
    const el = ref.current;
    const w = el?.offsetWidth || p.width || 200;
    const h = el?.offsetHeight || 200;
    let left = p.align === "right" ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = p.above ? r.top - h - 6 : r.bottom + 6;
    if (!p.above && top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    if (p.above && top < 8) top = r.bottom + 6;
    setPos({ left, top });
  }, [p.open, p.anchor, p.align, p.above, p.width]);
  // 监听器只随 open 变化：别的按键处理同步触发重渲染时，不会在事件派发中途被换掉（否则这次 Esc 收不到）
  const live = useRef({ onClose: p.onClose, anchor: p.anchor });
  live.current = { onClose: p.onClose, anchor: p.anchor };
  useEffect(() => {
    if (!p.open) return;
    const down = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node) || live.current.anchor?.contains(e.target as Node)) return;
      live.current.onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && live.current.onClose();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [p.open]);
  if (!p.open) return null;
  return createPortal(
    <div ref={ref} className="menu studio-root" style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: p.width }}>
      {p.children}
    </div>,
    document.body,
  );
}

export function useAnchor<T extends HTMLElement = HTMLButtonElement>() {
  const ref = useRef<T>(null);
  const [open, setOpen] = useState(false);
  return { ref, open, setOpen, toggle: () => setOpen((v) => !v), close: () => setOpen(false) };
}

export function MenuItem(p: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  meta?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" className={cx("menu-item", p.danger && "danger", p.active && "active")} disabled={p.disabled} onClick={p.onClick}>
      {p.icon}
      <span className="ellipsis">{p.children}</span>
      {p.meta !== undefined && <span className="meta">{p.meta}</span>}
    </button>
  );
}

// ---------- 弹窗 ----------
export function Modal(p: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  foot?: React.ReactNode;
  wide?: boolean;
  xl?: boolean;
  head?: React.ReactNode;
}) {
  const close = useRef(p.onClose);
  close.current = p.onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return createPortal(
    <div className="modal-back studio-root" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className={cx("modal", p.wide && "wide", p.xl && "xl")} role="dialog" aria-modal>
        <div className="modal-head">
          {p.icon}
          <div className="modal-title">{p.title}</div>
          <div className="spacer" />
          {p.head}
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={p.onClose} title="关闭 (Esc)" aria-label="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">{p.children}</div>
        {p.foot && <div className="modal-foot">{p.foot}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- 刻度拨杆（摄像机参数 / 体块参数） ----------
export function Dial(p: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  unit?: string;
  digits?: number;
  zero?: number;
  log?: boolean;
  title?: string;
  warm?: boolean;
  disabled?: boolean;
  onReset?: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const digits = p.digits ?? (p.step >= 1 ? 0 : p.step >= 0.1 ? 1 : 2);
  const toT = (v: number) => {
    if (p.log) return (Math.log(v) - Math.log(p.min)) / (Math.log(p.max) - Math.log(p.min));
    return (v - p.min) / (p.max - p.min);
  };
  const fromT = (t: number) => {
    t = Math.max(0, Math.min(1, t));
    const v = p.log ? Math.exp(Math.log(p.min) + t * (Math.log(p.max) - Math.log(p.min))) : p.min + t * (p.max - p.min);
    return Math.round(v / p.step) * p.step;
  };
  const clamp = (v: number) => Math.max(p.min, Math.min(p.max, Math.round(v / p.step) * p.step));
  const zero = p.zero ?? (p.min < 0 && p.max > 0 ? 0 : p.min);
  const t = toT(Math.max(p.min, Math.min(p.max, p.value)));
  const tz = toT(zero);
  const drag = (e: React.PointerEvent) => {
    if (p.disabled || !track.current) return;
    const el = track.current;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const startX = e.clientX;
    const startT = t;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const fine = ev.shiftKey ? 0.2 : 1;
      if (Math.abs(ev.clientX - startX) > 2) moved = true;
      if (!moved) return;
      p.onChange(fromT(startT + ((ev.clientX - startX) / r.width) * fine));
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      if (!moved) p.onChange(fromT((ev.clientX - r.left) / r.width));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const fmt = (v: number) => v.toFixed(digits);
  return (
    <div className={cx("dial", p.disabled && "disabled", p.warm && "warm")} title={p.title}>
      <span className="dial-label" onDoubleClick={p.onReset} title={p.onReset ? "双击复位" : undefined}>
        {p.label}
      </span>
      <button type="button" className="dial-step" tabIndex={-1} onClick={() => p.onChange(clamp(p.value - p.step * (p.step < 1 ? 5 : 1)))} aria-label="减小">
        <ChevronLeft size={12} />
      </button>
      <div
        ref={track}
        className="dial-track"
        onPointerDown={drag}
        onWheel={(e) => {
          if (p.disabled) return;
          e.preventDefault();
          p.onChange(clamp(p.value + (e.deltaY < 0 ? 1 : -1) * p.step * (e.shiftKey ? 1 : p.step < 1 ? 5 : 1)));
        }}
      >
        <div className="dial-ticks" />
        <div className="dial-fill" style={{ left: `${Math.min(t, tz) * 100}%`, width: `${Math.abs(t - tz) * 100}%` }} />
        <div className="dial-thumb" style={{ left: `${t * 100}%` }} />
      </div>
      <button type="button" className="dial-step" tabIndex={-1} onClick={() => p.onChange(clamp(p.value + p.step * (p.step < 1 ? 5 : 1)))} aria-label="增大">
        <ChevronRight size={12} />
      </button>
      {edit === null ? (
        <span className="dial-value num" onClick={() => !p.disabled && setEdit(fmt(p.value))} title="点击输入">
          {fmt(p.value)}
          {p.unit}
        </span>
      ) : (
        <input
          className="input input-sm dial-input num"
          autoFocus
          value={edit}
          onChange={(e) => setEdit(e.target.value)}
          onBlur={() => {
            const v = parseFloat(edit);
            if (Number.isFinite(v)) p.onChange(clamp(v));
            setEdit(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEdit(null);
          }}
        />
      )}
    </div>
  );
}

// ---------- 数字框（位置 / 尺寸） ----------
export function NumField(p: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; disabled?: boolean; width?: number }) {
  const [v, setV] = useState(String(Math.round(p.value)));
  useEffect(() => setV(String(Math.round(p.value))), [p.value]);
  const commit = () => {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) p.onChange(Math.max(p.min ?? -Infinity, Math.min(p.max ?? Infinity, n)));
    else setV(String(Math.round(p.value)));
  };
  return (
    <label className="numfield" style={{ width: p.width }}>
      <span>{p.label}</span>
      <input
        className="input input-sm num"
        value={v}
        disabled={p.disabled}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const n = (parseInt(v, 10) || 0) + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
            setV(String(n));
            p.onChange(n);
          }
        }}
      />
    </label>
  );
}

/** 自动增高的文本框 */
type ATProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number; maxRows?: number };
export const AutoTextarea = React.forwardRef<HTMLTextAreaElement, ATProps>(function AutoTextarea(p, fwd) {
  const { minRows = 2, maxRows = 12, ...rest } = p;
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(fwd, () => ref.current as HTMLTextAreaElement);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const lh = 19.4;
    const h = Math.min(Math.max(el.scrollHeight + 2, minRows * lh + 14), maxRows * lh + 14);
    el.style.height = `${h}px`;
  }, [p.value, minRows, maxRows]);
  return <textarea ref={ref} {...rest} />;
});

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd>{children}</kbd>;
}
