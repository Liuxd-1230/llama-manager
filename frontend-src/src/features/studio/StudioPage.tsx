import "./styles/base.css";
import "./styles/app.css";
import { AlertTriangle, CheckCircle2, Info, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { api } from "./api";
import { AgentPanel } from "./components/AgentPanel";
import { DirectorView } from "./components/DirectorView";
import { DocPanel } from "./components/DocPanel";
import { Modals } from "./components/Modals";
import { Stage } from "./components/Stage";
import { TopBar } from "./components/TopBar";
import { DialogHost } from "./dialog";
import { cameraMoved } from "./lib/camera";
import { expandGroups } from "./lib/doc";
import {
  assistAgent, boot, compileNow, duplicateItems, flushSave, flushSaveOnExit, groupSelection, nudgeInView, openDirector, redo, removeItems, reorder, select,
  setUi, undo, ungroupSelection, updateItems, useStore,
} from "./store";
import type { BBox } from "./types";

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (!s.doc) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key === "Enter") {
        // 一键交给 Agent 补全；在镜头调度里就顺便退出，回到能看到结果的主界面
        e.preventDefault();
        if (s.modal) return;
        if (assistAgent() && s.director) setUi({ director: false });
        return;
      }
      if (mod && e.key === "Enter") {
        e.preventDefault();
        void compileNow(true);
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void flushSave({ source: "manual", summary: "手动保存" });
        return;
      }
      if (s.modal) return;
      if (mod && e.key.toLowerCase() === "g" && !isTyping(e) && s.doc.kind === "layout") {
        // 成组 / 解组（镜头调度里也能用）
        e.preventDefault();
        e.shiftKey ? ungroupSelection() : groupSelection();
        return;
      }
      if (s.director) {
        // 镜头调度里只保留撤销 / 重做，其余按键交给调度视图
        if (isTyping(e) || !mod) return;
        const k = e.key.toLowerCase();
        if (k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
        else if (k === "y") { e.preventDefault(); redo(); }
        return;
      }
      if (e.key === "Escape" && s.freeCam) {
        setUi({ freeCam: false });
        return;
      }
      if (isTyping(e)) return;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (s.doc.kind !== "layout") return;
      const L = s.doc.layout;
      if (e.shiftKey && (e.key === "`" || e.key === "~" || e.code === "Backquote")) {
        e.preventDefault();
        if (L.camera?.enabled) setUi({ freeCam: !s.freeCam });
        return;
      }
      if (!mod && !e.altKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        openDirector();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        select(L.items.map((x) => x.id));
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateItems(s.selection);
        return;
      }
      if (e.key === "Escape") return select([]);
      if (e.key === "Delete" || e.key === "Backspace") return removeItems(s.selection);
      if (e.key === "v" || e.key === "V") return setUi({ tool: "select" });
      if (e.key === "b" || e.key === "B") return setUi({ tool: "draw" });
      if (e.key === "]") return reorder(s.selection, e.shiftKey ? "top" : "up");
      if (e.key === "[") return reorder(s.selection, e.shiftKey ? "bottom" : "down");
      if (e.key === "}") return reorder(s.selection, "top");
      if (e.key === "{") return reorder(s.selection, "bottom");
      if (e.key.startsWith("Arrow") && s.selection.length) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
        const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
        if (cameraMoved(L)) {
          // 镜头视图：按画面方向微移，换算回原框（按当前的移动方式：自由 / 冻结、镜头固定 / 随主体；Alt 只动选中的）
          nudgeInView(dx, dy, e.altKey);
          return;
        }
        const ids = e.altKey ? s.selection : expandGroups(L.items, s.selection);
        const pinned = new Set(L.items.filter((x) => x.locked && x.group && ids.includes(x.id)).map((x) => x.group!));
        const movers = L.items.filter((it) => ids.includes(it.id) && !it.locked && !(!e.altKey && it.group && pinned.has(it.group)));
        if (!movers.length) return;
        // 整组一起夹在画布里（只阻止继续往外移，已经在画外的不强行拉回）
        const ux1 = Math.min(...movers.map((it) => it.bbox[0])), uy1 = Math.min(...movers.map((it) => it.bbox[1]));
        const ux2 = Math.max(...movers.map((it) => it.bbox[2])), uy2 = Math.max(...movers.map((it) => it.bbox[3]));
        const mx = dx < 0 ? Math.max(dx, Math.min(0, -ux1)) : Math.min(dx, Math.max(0, L.width - ux2));
        const my = dy < 0 ? Math.max(dy, Math.min(0, -uy1)) : Math.min(dy, Math.max(0, L.height - uy2));
        const patches: Record<string, { bbox: BBox }> = {};
        for (const it of movers) {
          const [x1, y1, x2, y2] = it.bbox;
          patches[it.id] = { bbox: [x1 + mx, y1 + my, x2 + mx, y2 + my] };
        }
        updateItems(patches, "nudge");
      }
    };
    window.addEventListener("keydown", onKey);
    const onExit = () => flushSaveOnExit();
    const onHide = () => { if (document.visibilityState === "hidden") void flushSave(); };
    window.addEventListener("beforeunload", onExit);
    window.addEventListener("pagehide", onExit);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onExit);
      window.removeEventListener("pagehide", onExit);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === "ok" ? <CheckCircle2 size={14} /> : t.kind === "err" ? <AlertTriangle size={14} /> : <Info size={14} />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

function App() {
  const ready = useStore((s) => s.ready);
  const bootError = useStore((s) => s.bootError);
  const director = useStore((s) => s.director && s.doc?.kind === "layout");
  useShortcuts();
  useEffect(() => {
    void boot();
  }, []);
  if (!ready)
    return (
      <div className="boot">
        <div className="brand-mark big">M</div>
        {bootError ? (
          <>
            <div className="boot-err"><AlertTriangle size={14} />无法连接本地服务：{bootError}</div>
            <button type="button" className="btn" onClick={() => location.reload()}>重试</button>
          </>
        ) : (
          <div className="muted row"><Loader2 size={14} className="spin" />正在打开工作区…</div>
        )}
      </div>
    );
  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <DocPanel />
        <Stage />
        <AgentPanel />
      </div>
      {director && <DirectorView />}
      <Modals />
      <DialogHost />
      <Toasts />
    </div>
  );
}

/** Host wrapper: scopes the studio palette (.studio-root) to the host theme. */
export function PromptStudioPage() {
  useEffect(() => {
    // Settings now live only in the global drawer; keep the store fresh.
    const refresh = () => { void api.settings().then(settings => useStore.setState({ settings })).catch(() => undefined) }
    window.addEventListener('moss-settings-changed', refresh)
    return () => window.removeEventListener('moss-settings-changed', refresh)
  }, [])

  return (
    <div className="studio-root" style={{ height: "100%" }}>
      <App />
    </div>
  );
}
