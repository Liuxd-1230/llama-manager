import { ChevronDown, Loader2, Send, Wand2 } from "lucide-react";
import React, { useMemo, useState } from "react";
import { assistStats, loadAssistPrefs, saveAssistPrefs, type AssistPrefs } from "../lib/assist";
import { assistAgent, useStore } from "../store";
import { AutoTextarea, Popover, cx, useAnchor } from "../../../components/kit";

/**
 * 「交给 Agent 补全」分裂按钮：主按钮一键发送（按上次的勾选），右侧箭头展开选项和补充要求。
 * onSent：发出后要做的事（比如退出镜头调度回到主界面看结果）。
 */
export function AssistButton({ size = "sm", onSent, label = "Agent 补全", compact }: {
  size?: "sm" | "xs";
  onSent?: () => void;
  label?: string;
  /** 窄工具栏：只显示图标 */
  compact?: boolean;
}) {
  const doc = useStore((s) => s.doc);
  const selCount = useStore((s) => s.selection.length);
  const busy = useStore((s) => !!s.streaming);
  const menu = useAnchor();
  const [prefs, setPrefs] = useState<AssistPrefs>(loadAssistPrefs);
  const [note, setNote] = useState("");
  const st = useMemo(() => (doc && menu.open ? assistStats(doc) : null), [doc, menu.open]);
  if (!doc) return null;
  const isCaption = doc.kind === "caption";
  const upd = (p: Partial<AssistPrefs>) => {
    const n = { ...prefs, ...p };
    setPrefs(n);
    saveAssistPrefs(n);
  };
  const go = (withNote: boolean) => {
    const cur = loadAssistPrefs();
    const ok = assistAgent({ prefs: { ...cur, onlySel: cur.onlySel && selCount > 0 }, note: withNote ? note : "" });
    if (!ok) return;
    if (withNote) setNote("");
    menu.close();
    onSent?.();
  };
  const cls = size === "xs" ? "btn-xs" : "btn-sm";
  const row = (k: keyof AssistPrefs, text: React.ReactNode, hint?: string, disabled?: boolean) => (
    <label className={cx("assist-opt", disabled && "off")} title={hint}>
      <input type="checkbox" checked={!!prefs[k] && !disabled} disabled={disabled} onChange={(e) => upd({ [k]: e.target.checked } as Partial<AssistPrefs>)} />
      <span>{text}</span>
    </label>
  );
  return (
    <>
      <div className="btn-split assist-split">
        <button type="button" className={cx("btn btn-agent", cls)} onClick={() => go(false)}
          title={isCaption ? "把当前 Caption 交给 Agent 补全润色（Ctrl+Shift+Enter）" : "把当前整体描述、框和机位交给 Agent 补全提示词，不改构图（Ctrl+Shift+Enter）"}>
          {busy ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />}{!compact && <span className="bar-lbl3">{label}</span>}
        </button>
        <button ref={menu.ref} type="button" className={cx("btn btn-agent btn-icon", cls)} onClick={menu.toggle} title="补全选项与补充要求">
          <ChevronDown size={12} />
        </button>
      </div>
      <Popover anchor={menu.ref.current} open={menu.open} onClose={menu.close} width={318} align="right">
        <div className="assist-pop">
          <div className="assist-head"><Wand2 size={13} />交给 Agent 补全{isCaption ? " Caption" : "提示词"}</div>
          {st && (
            <div className="assist-stats">
              {isCaption ? (
                <span>Caption {st.captionLen} 字</span>
              ) : (
                <>
                  <span>整体描述 {st.summaryLen ? `${st.summaryLen} 字` : <b>空</b>}</span>
                  <span>{st.items} 个框{st.empty ? <> · <b>{st.empty} 个没写描述</b></> : null}{st.short ? ` · ${st.short} 个过短` : ""}{st.textMissing ? ` · ${st.textMissing} 个文字框缺文字` : ""}</span>
                  <span>机位：{st.camOn ? st.phrase : "未开摄像机"}</span>
                </>
              )}
            </div>
          )}
          {!isCaption && (
            <div className="assist-opts">
              {row("fill", "补全空白 / 过短的描述")}
              {row("camera", "按当前机位写清可见面和透视", "需要先打开摄像机", !st?.camOn)}
              {row("unify", "统一整体描述与各框（主体、风格、光线）")}
              {row("check", "检查文字框和框的类型")}
              {row("onlySel", selCount ? `只改选中的 ${selCount} 个框` : "只改选中的框（当前没有选中）", undefined, !selCount)}
            </div>
          )}
          <AutoTextarea className="textarea assist-note" minRows={2} maxRows={6} value={note} placeholder="补充要求（可选），例如：整体更压抑、改成雨夜、服装偏写实"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(true); } }} />
          <div className="assist-foot">
            <span className="hint">不移动框、不改机位；改动先进待确认卡片</span>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => go(true)}><Send size={12} />{busy ? "排队发送" : "发送"}</button>
          </div>
        </div>
      </Popover>
    </>
  );
}
