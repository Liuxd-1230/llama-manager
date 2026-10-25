import { ApiError } from "../../api";
import type {
  AppSettings, ArchiveItem, Attachment, CompileResult, Doc, Message, Page, Revision, Series, Session,
  Skill, SkillKind, SkillsState,
} from "./types";

async function parseError(r: Response, path: string): Promise<ApiError> {
  let msg = `${r.status} ${r.statusText}`;
  try {
    const j = await r.json();
    if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
  } catch {
    /* ignore */
  }
  return new ApiError(`${msg} @ ${path}`, r.status);
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/moss${path}`, {
    method,
    headers: body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  if (!r.ok) throw await parseError(r, path);
  return (await r.json()) as T;
}

/** 页面关闭时用：keepalive 请求在页面卸载后仍会发完 */
export function putKeepalive(path: string, body: unknown) {
  try {
    void fetch(`/api/moss${path}`, { method: "PUT", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    /* ignore */
  }
}

const get = <T,>(p: string) => req<T>("GET", p);
const post = <T,>(p: string, b?: unknown) => req<T>("POST", p, b ?? {});
const put = <T,>(p: string, b: unknown) => req<T>("PUT", p, b);
const patch = <T,>(p: string, b: unknown) => req<T>("PATCH", p, b);
const del = <T,>(p: string) => req<T>("DELETE", p);

// ---------- 工作区 ----------
export const api = {
  workspace: () => get<{ series: Series[]; state: Record<string, unknown> }>("/workspace"),
  putState: (state: Record<string, unknown>) => put("/state", { state }),
  createSeries: (name: string) => post<Series>("/series", { name }),
  renameSeries: (id: string, name: string) => patch(`/series/${id}`, { name }),
  deleteSeries: (id: string) => del(`/series/${id}`),
  createPage: (b: { series_id: string; name?: string; doc?: Doc; kind?: string; width?: number; height?: number }) =>
    post<Page>("/pages", b),
  getPage: (id: string) => get<Page>(`/pages/${id}`),
  savePage: (id: string, b: { doc?: Doc; name?: string; sort?: number; revision?: { source: string; summary?: string } }) =>
    put<Page>(`/pages/${id}`, b),
  duplicatePage: (id: string) => post<Page>(`/pages/${id}/duplicate`),
  deletePage: (id: string) => del(`/pages/${id}`),
  revisions: (pid: string) => get<Revision[]>(`/pages/${pid}/revisions`),
  revision: (rid: string) => get<Revision & { doc: Doc }>(`/revisions/${rid}`),
  restoreRevision: (rid: string) => post<Page>(`/revisions/${rid}/restore`),

  // ---------- 会话 ----------
  sessions: (seriesId: string) => get<Session[]>(`/series/${seriesId}/sessions`),
  createSession: (series_id: string, title?: string) => post<Session>("/sessions", { series_id, title }),
  patchSession: (id: string, b: { title?: string; closed?: boolean }) => patch<Session>(`/sessions/${id}`, b),
  deleteSession: (id: string) => del(`/sessions/${id}`),
  clearSession: (id: string) => post<Session>(`/sessions/${id}/clear`, {}),
  messages: (sid: string) => get<Message[]>(`/sessions/${sid}/messages`),
  resolveProposal: (mid: string, b: { page_id: string; status: string; applied_doc?: Doc }) =>
    post<{ message: Message; page: Page | null }>(`/messages/${mid}/proposal`, b),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<Attachment>("POST", "/attachments", fd);
  },

  // ---------- 档案库 ----------
  archive: () => get<ArchiveItem[]>("/archive"),
  addArchive: (b: { title: string; category: string; doc: Doc; prompt: string }) => post<ArchiveItem>("/archive", b),
  patchArchive: (id: string, b: { title?: string; category?: string }) => patch<ArchiveItem>(`/archive/${id}`, b),
  deleteArchive: (id: string) => del(`/archive/${id}`),

  // ---------- 编译 / 设置 / 反推 ----------
  compile: (draft: unknown, view?: unknown) => post<CompileResult>("/compile", { draft, view }),
  settings: () => get<AppSettings>("/settings"),
  saveSettings: (b: Partial<AppSettings>) => put<AppSettings>("/settings", b),
  testSettings: (b: { provider_id?: string; model?: string }) =>
    post<{
      ok: boolean; message: string; stream_ok: boolean; tools_ok: boolean; chat_ok: boolean; models_ok: boolean;
      latency_ms: number | null; sample_models: string[]; model_count: number;
    }>("/settings/test", b),
  models: (b: { provider_id?: string; model?: string }) =>
    post<{ models: string[]; count: number }>("/settings/models", b),
  reverse: (file: File, mode: "caption" | "layout", detail: string, width?: number, height?: number, imageWidth?: number, imageHeight?: number) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("mode", mode);
    fd.append("detail", detail);
    if (width) fd.append("width", String(width));
    if (height) fd.append("height", String(height));
    if (imageWidth) fd.append("image_width", String(imageWidth));
    if (imageHeight) fd.append("image_height", String(imageHeight));
    return req<Record<string, any>>("POST", "/reverse", fd);
  },

  // ---------- Skills ----------
  skills: () => get<SkillsState>("/skills"),
  setActiveSkill: (kind: SkillKind, id: string) => put<SkillsState>("/skills/active", { kind, id }),
  createSkill: (b: { name: string; kind: SkillKind; description?: string; system_prompt: string }) =>
    post<Skill>("/skills", b),
  updateSkill: (id: string, b: { name?: string; description?: string; system_prompt?: string }) =>
    put<Skill>(`/skills/${id}`, b),
  resetSkill: (id: string) => post<Skill>(`/skills/${id}/reset`),
  duplicateSkill: (id: string) => post<Skill>(`/skills/${id}/duplicate`),
  deleteSkill: (id: string) => del(`/skills/${id}`),
};

export const attachmentUrl = (id: string) => `/attachments/${id}`;

// ---------- Agent 流式 ----------
export type AgentEvent =
  | { type: "user_saved"; message: Message }
  | { type: "model"; model: string }
  | { type: "text"; delta: string }
  | { type: "tool_pending"; name: string; label: string }
  | { type: "tool"; name: string; label: string; brief: string; ok: boolean; result: string }
  | { type: "ask"; question: string; options: string[]; multi: boolean }
  | { type: "page_created"; page: Page }
  | { type: "notice"; message: string }
  | { type: "proposal"; message_id: string; page_id: string; page_name: string; base: Doc; proposed: Doc; summary: string[]; status: string }
  | { type: "error"; message: string }
  | { type: "done"; message: Message };

export interface RunBody {
  page_id: string;
  doc: Doc;
  view?: unknown;
  message: string;
  selection: string[];
  skill_ids: string[];
  attachments: string[];
  replace_from_seq?: number | null;
  quick?: string | null;
  mode?: string | null;
}

export async function runAgent(sid: string, body: RunBody, onEvent: (e: AgentEvent) => void, signal: AbortSignal) {
  const r = await fetch(`/api/moss/sessions/${sid}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok || !r.body) throw await parseError(r, `/sessions/${sid}/run`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as AgentEvent);
        } catch {
          /* 跳过坏分片 */
        }
      }
    }
  }
}
