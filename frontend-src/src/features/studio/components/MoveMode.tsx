/**
 * 镜头视图里移动体块的方式：自由 / 冻结（整体），镜头 固定 / 随主体。主画布和镜头调度共用一份设置。
 */
import { ChevronDown, Lock, Move, Snowflake, Video } from "lucide-react";
import { setMovePrefs, useStore } from "../store";
import { Popover, Seg, cx, useAnchor } from "../ui";

export const SCOPE_TEXT = { free: "自由", frozen: "冻结" } as const;
export const HOLD_TEXT = { fixed: "镜头固定", subject: "镜头随主体" } as const;

export function MoveModeMenu({ small, label = true, align = "left" }: { small?: boolean; label?: boolean; align?: "left" | "right" }) {
  const scope = useStore((s) => s.moveScope);
  const hold = useStore((s) => s.moveHold);
  const m = useAnchor();
  return (
    <span className="move-mode" onPointerDown={(e) => e.stopPropagation()}>
      <button ref={m.ref} type="button" className={cx("btn", small ? "btn-xs" : "btn-sm", "move-mode-btn", scope === "frozen" && "on")} onClick={m.toggle}
        title="镜头视图里拖动体块的方式：自由 / 冻结（整体移动），镜头固定 / 随主体">
        {scope === "frozen" ? <Snowflake size={12} /> : <Move size={12} />}
        {label && <span className="move-mode-lbl">{SCOPE_TEXT[scope]} · {HOLD_TEXT[hold]}</span>}
        <ChevronDown size={11} className="muted" />
      </button>
      <Popover anchor={m.ref.current} open={m.open} onClose={m.close} width={300} align={align}>
        <div className="move-menu" onPointerDown={(e) => e.stopPropagation()}>
          <div className="menu-label">拖动体块</div>
          <Seg full small value={scope} onChange={(v) => setMovePrefs({ moveScope: v })} options={[
            { v: "free", t: <><Move size={12} />自由</>, title: "拖哪个动哪个；成组的框整组一起动" },
            { v: "frozen", t: <><Snowflake size={12} />冻结（整体）</>, title: "所有 3D 体块当成一个整体一起移动" },
          ]} />
          <div className="menu-note">
            {scope === "free"
              ? "拖哪个动哪个，成组的框整组一起动。按住 Alt 拖动只动选中的这一个（组内微调）。"
              : "拖任意一个 3D 体块，所有体块整体一起移动、相对位置不变；文字和背景板贴在画面上，不跟着动。锁定的框不动。"}
          </div>
          <div className="menu-label">移动时的镜头</div>
          <Seg full small value={hold} onChange={(v) => setMovePrefs({ moveHold: v })} options={[
            { v: "fixed", t: <><Lock size={12} />固定</>, title: "镜头留在原地不动" },
            { v: "subject", t: <><Video size={12} />随主体</>, title: "镜头像架在主体身上，主体动它跟着动" },
          ]} />
          <div className="menu-note">
            {hold === "fixed"
              ? "镜头留在原地：拖动的体块在画面里跟着鼠标走，其他框和机位都不动（主体远近变了也会自动补偿机位，不会跳）。"
              : scope === "frozen"
                ? "镜头和所有体块一起平移：当前画面保持不变，改的是初始机位下的原构图（在镜头调度里打开「原框虚影」可以看到）。"
                : "镜头像架在主体身上：移动主体（或它所在的组）时镜头一起平移，主体在画面里不动、周围场景反向移动；移动其他框时镜头不动。"}
          </div>
        </div>
      </Popover>
    </span>
  );
}
