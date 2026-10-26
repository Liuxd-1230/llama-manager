import {
  Archive, Check, ChevronDown, Copy, FileText, FolderPlus, History, ImageUp, LayoutGrid, Loader2, Pencil, Plus,
  Redo2, Settings, Sparkles, Trash2, Undo2, CloudOff,
} from "lucide-react";
import { useState } from "react";
import {
  addPage, addSeries, currentSeries, deletePage, deleteSeries, duplicatePage, redo, renamePage, renameSeries,
  selectPage, setUi, undo, useStore, useWorkState } from "../store";
import { openGlobalSettings } from "../globalSettings";
import { confirmDialog, promptDialog } from "../dialog";
import { MenuItem, Popover, cx, useAnchor } from "../../../components/kit";

function PageTab({ id, name, kind, active, pending }: { id: string; name: string; kind: string; active: boolean; pending: boolean }) {
  const [edit, setEdit] = useState<string | null>(null);
  const menu = useAnchor<HTMLDivElement>();
  return (
    <div
      ref={menu.ref}
      className={cx("page-tab", active && "on")}
      onClick={() => selectPage(id)}
      onDoubleClick={() => setEdit(name)}
      onContextMenu={(e) => {
        e.preventDefault();
        menu.setOpen(true);
      }}
      title={`${name}（双击重命名，右键更多）`}
    >
      {kind === "layout" ? <LayoutGrid size={12} /> : <FileText size={12} />}
      {edit === null ? (
        <span className="ellipsis">{name}</span>
      ) : (
        <input
          className="page-tab-input"
          autoFocus
          value={edit}
          onChange={(e) => setEdit(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => {
            if (edit.trim() && edit !== name) void renamePage(id, edit.trim());
            setEdit(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEdit(null);
          }}
        />
      )}
      {pending && <span className="page-tab-dot" title="有待确认的 Agent 改动" />}
      <Popover anchor={menu.ref.current} open={menu.open} onClose={menu.close}>
        <MenuItem icon={<Pencil size={14} />} onClick={() => { menu.close(); setEdit(name); }}>重命名</MenuItem>
        <MenuItem icon={<Copy size={14} />} onClick={() => { menu.close(); void duplicatePage(id); }}>复制此页</MenuItem>
        <div className="menu-sep" />
        <MenuItem icon={<Trash2 size={14} />} danger onClick={async () => { menu.close(); if (await confirmDialog(`删除「${name}」？`, "此页的版本记录也会一起删除，Agent 对话保留。", { okText: "删除", danger: true })) void deletePage(id); }}>
          删除此页
        </MenuItem>
      </Popover>
    </div>
  );
}

export function TopBar() {
  const s = useWorkState();
  const se = currentSeries(s);
  const seriesMenu = useAnchor();
  const pendingPages = new Set(
    Object.values(s.messages).flat().flatMap((m) => (m.meta?.proposals || []).filter((p) => p.status === "pending").map((p) => p.page_id)),
  );
  return (
    <header className="topbar">
      <div className="brand" title="MOSS 提示词工作台">
        <div className="brand-mark">M</div>
        <div className="brand-text">
          <b>MOSS Studio</b>
          <span>提示词工作台</span>
        </div>
      </div>
      <div className="topbar-sep" />
      <button ref={seriesMenu.ref} type="button" className="btn btn-sm series-btn" onClick={seriesMenu.toggle} title="系列：同一系列的分页共享 Agent 对话">
        <span className="muted">系列</span>
        <b className="ellipsis">{se?.name}</b>
        <ChevronDown size={13} />
      </button>
      <Popover anchor={seriesMenu.ref.current} open={seriesMenu.open} onClose={seriesMenu.close} width={240}>
        <div className="menu-label">切换系列</div>
        {s.series.map((x) => (
          <MenuItem key={x.id} active={x.id === s.seriesId} meta={`${x.pages.length} 页`} icon={x.id === s.seriesId ? <Check size={14} /> : <span style={{ width: 14 }} />}
            onClick={() => { seriesMenu.close(); if (x.id !== s.seriesId) void selectPage(x.pages[0].id); }}>
            {x.name}
          </MenuItem>
        ))}
        <div className="menu-sep" />
        <MenuItem icon={<FolderPlus size={14} />} onClick={async () => { seriesMenu.close(); const n = await promptDialog("新系列名称", "新系列", "同一系列的分页共享 Agent 对话与角色设定。"); if (n) void addSeries(n); }}>新建系列</MenuItem>
        <MenuItem icon={<Pencil size={14} />} onClick={async () => { seriesMenu.close(); const n = await promptDialog("重命名系列", se?.name); if (n && se) void renameSeries(se.id, n); }}>重命名当前系列</MenuItem>
        <MenuItem icon={<Trash2 size={14} />} danger disabled={s.series.length < 1}
          onClick={async () => { seriesMenu.close(); if (se && (await confirmDialog(`删除系列「${se.name}」？`, "会同时删除它的全部分页、版本记录和 Agent 对话，无法恢复。", { okText: "删除系列", danger: true }))) void deleteSeries(se.id); }}>
          删除当前系列
        </MenuItem>
      </Popover>

      <div className="page-tabs">
        {se?.pages.map((p) => (
          <PageTab key={p.id} id={p.id} name={p.name} kind={p.id === s.pageId ? s.doc?.kind || p.doc.kind : p.doc.kind}
            active={p.id === s.pageId} pending={pendingPages.has(p.id)} />
        ))}
        <button type="button" className="btn btn-ghost btn-sm btn-icon" title="新建一页（同系列共享对话）" onClick={() => void addPage()}>
          <Plus size={15} />
        </button>
      </div>

      <div className="spacer" />
      <span className={cx("save-state", s.saveState)} title="自动保存到本地数据库">
        {s.saveState === "saving" || s.saveState === "pending" ? <Loader2 size={12} className="spin" /> : s.saveState === "error" ? <CloudOff size={12} /> : <Check size={12} />}
        {s.saveState === "error" ? "保存失败" : s.saveState === "saved" ? "已保存" : "保存中"}
      </span>
      <div className="key-group">
        <button type="button" className="btn btn-sm btn-icon" disabled={!s.undo.length} onClick={undo} title="撤销 Ctrl+Z"><Undo2 size={14} /></button>
        <button type="button" className="btn btn-sm btn-icon" disabled={!s.redo.length} onClick={redo} title="重做 Ctrl+Shift+Z"><Redo2 size={14} /></button>
      </div>
      <div className="topbar-sep" />
      <button type="button" className="btn btn-sm" onClick={() => setUi({ modal: "reverse" })} title="从参考图反推 Caption / Layout"><ImageUp size={14} />反推</button>
      <button type="button" className={`btn btn-sm${s.workspace === "image" ? " on" : ""}`} onClick={() => setUi({ workspace: s.workspace === "image" ? "edit" : "image" })} title={s.workspace === "image" ? "返回编辑（Layout / Caption）" : "切换到出图工作区（ComfyUI）"}><Sparkles size={14} />{s.workspace === "image" ? "编辑" : "出图"}</button>
      <button type="button" className="btn btn-sm" onClick={() => setUi({ modal: "archive" })} title="档案库：保存和复用整页文档"><Archive size={14} />档案库</button>
      <button type="button" className="btn btn-sm" onClick={() => setUi({ modal: "revisions" })} title="此页的操作记录，可回滚"><History size={14} />记录</button>
      <button type="button" className="btn btn-sm" onClick={() => setUi({ modal: "skills" })} title="Skills：Caption / Layout / 改稿风格"><Sparkles size={14} />Skills</button>
      <button type="button" className="btn btn-sm btn-icon" onClick={openGlobalSettings} title="设置"><Settings size={15} /></button>
    </header>
  );
}
