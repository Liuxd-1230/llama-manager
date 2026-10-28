import { readAgentFrames } from "./agentStream";
import { ApiError, api as sharedApi } from "../../api";
import type {
  AppSettings, ArchiveItem, Attachment, CompileResult, Doc, Message, Page, Revision, Series, Session,
  Skill, SkillKind, SkillsState,
} from "./types";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  return sharedApi<T>(`/api/v1/moss${path}`, { method, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) }, 300000);
}

/** 页面关闭时用：keepalive 请求在页面卸载后仍会发完 */
export function putKeepalive(path: string, body: unknown) {
  try {
    void fetch(`/api/v1/moss${path}`, { method: "PUT", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
  activeAgent: (sid: string) => get<{job_id: string | null}>(`/sessions/${sid}/run`),
  workspace: () => get<{ series: Series[]; state: Record<string, unknown>; project_id?: string }>("/workspace"),
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
  resolveProposal: (mid: string, b: { page_id: string; status: string; applied_doc?: Doc; expected_doc?: Doc }) =>
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
  comfyStatus: () => get<{ url: string; reachable: boolean; has_workflow: boolean; bindings: Record<string, { node: string; input: string }>; fields: Record<string, string>; nodes: { node: string; class_type: string; title: string; inputs: { name: string; type: string; is_link: boolean; value: string | number | boolean | null }[] }[]; binding_errors: string[]; workflows: { id: string; name: string; nodes: number; bindings: number; active: boolean }[]; active_id: string; active_name: string; graph?: import("./components/ComfyGraphView").ComfyGraph; params?: Record<string, unknown>; defaults?: Record<string, unknown>; overrides?: Record<string, unknown> }>("/comfy/status"),
  comfyWorkflows: () => get<{ workflows: { id: string; name: string; nodes: number; bindings: number; active: boolean }[]; active_id: string }>("/comfy/workflows"),
  comfyActivate: (id: string) => put<{ active_id: string; workflows: { id: string; name: string; nodes: number; bindings: number; active: boolean }[] }>("/comfy/workflows/active", { id }),
  comfyRenameWorkflow: (id: string, name: string) => put<{ workflows: { id: string; name: string; nodes: number; bindings: number; active: boolean }[] }>(`/comfy/workflows/${id}`, { name }),
  comfyDeleteWorkflow: (id: string) => del<{ workflows: { id: string; name: string; nodes: number; bindings: number; active: boolean }[]; active_id: string }>(`/comfy/workflows/${id}`),
  comfyImport: (workflow: string, name?: string) => post<{ id: string; name: string; nodes: { node: string; class_type: string; title: string; inputs: { name: string; type: string; is_link: boolean; value: string | number | boolean | null }[] }[]; fields: Record<string, string>; suggested: Record<string, { node: string; input: string }>; workflows: { id: string; name: string; nodes: number; bindings: number; active: boolean }[] }>("/comfy/import", { workflow, name }),
  comfyUrl: (url: string) => put<{ url: string }>("/comfy/url", { url }),
  comfyParams: (p: Record<string, unknown>) => put<{ params: Record<string, unknown> }>("/comfy/params", p),
  comfyChoices: () => get<{ samplers: string[]; schedulers: string[]; models?: Record<string,string[]> }>("/comfy/choices"),
  comfyGraph: () => get<{ nodes: { id: string; title: string; class_type: string; position: { x: number; y: number }; inputs: { name: string; type: string; is_link: boolean; value: string | number | boolean | null }[] }[]; edges: { id: string; source: string; target: string; target_input: string }[] }>("/comfy/graph"),
  comfyLayout: (positions: Record<string, { x: number; y: number }>, workflow_id?: string) => put<{ positions: Record<string, { x: number; y: number }> }>("/comfy/layout", { positions, workflow_id }),
  comfyBindings: (bindings: Record<string, { node: string; input: string }>, workflow_id?: string) => put<{ bindings: Record<string, { node: string; input: string }> }>("/comfy/bindings", { bindings, workflow_id }),
  comfyGenerate: (b: Record<string, unknown>) => post<{ image: string; filename: string; count: number; prompt_id: string }>("/comfy/generate", b),
  models: (b: { provider_id?: string; model?: string }) =>
    post<{ models: string[]; count: number }>("/settings/models", b),
  reverse: (file: File, mode: "caption" | "layout", detail: string, width?: number, height?: number, imageWidth?: number, imageHeight?: number, providerId?: string) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("mode", mode);
    fd.append("detail", detail);
    if (width) fd.append("width", String(width));
    if (height) fd.append("height", String(height));
    if (imageWidth) fd.append("image_width", String(imageWidth));
    if (imageHeight) fd.append("image_height", String(imageHeight));
    if (providerId) fd.append("provider_id", providerId);
    return req<Record<string, any>>("POST", "/reverse", fd);
  },

  // ---------- Skills ----------
  skills: () => get<SkillsState>("/skills"),
  setActiveSkill: (kind: SkillKind, id: string) => put<SkillsState>("/skills/active", { kind, id }),
  // Mutations return the whole store plus the affected skill, not a bare Skill.
  createSkill: (b: { name: string; kind: SkillKind; description?: string; system_prompt: string }) =>
    post<SkillsState & { skill: Skill }>("/skills", b),
  updateSkill: (id: string, b: { name?: string; description?: string; system_prompt?: string }) =>
    put<SkillsState & { skill: Skill }>(`/skills/${id}`, b),
  resetSkill: (id: string) => post<SkillsState & { skill: Skill }>(`/skills/${id}/reset`),
  duplicateSkill: (id: string) => post<SkillsState & { skill: Skill }>(`/skills/${id}/duplicate`),
  deleteSkill: (id: string) => del(`/skills/${id}`),
};

export const attachmentUrl = (id: string) => `/attachments/${id}`;

// ---------- Agent 流式 ----------
export type AgentEvent =
  | { type: "user_saved"; message: Message }
  | { type: "model"; model: string }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_pending"; name: string; label: string }
  | { type: "tool"; name: string; label: string; brief: string; ok: boolean; result: string }
  | { type: "ask"; question: string; options: string[]; multi: boolean }
  | { type: "page_created"; page: Page }
  | { type: "notice"; message: string }
  | { type: "text_reset" }
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

export async function runAgent(sid: string, body: RunBody, onEvent: (e: AgentEvent) => void, signal: AbortSignal, resumeJobId?: string) {
  let jobId = resumeJobId || ''
  const requestId=crypto.randomUUID()
  let sequence = 0
  let finished = false
  let retries = 0
  const stop = () => { void sharedApi(jobId ? `/api/v1/jobs/${jobId}/cancel` : `/api/v1/moss/sessions/${sid}/cancel`, { method: 'POST', body:jobId ? undefined : JSON.stringify({request_id:requestId}) }).catch(() => undefined) }
  signal.addEventListener('abort', stop, { once: true })
  try {
    let response = resumeJobId ? null : await fetch(`/api/v1/moss/sessions/${sid}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({...body, request_id: requestId}), signal,
    })
    if (response) {
      if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new ApiError(payload.message || payload.detail || `HTTP ${response.status}`, response.status) }
      jobId = response.headers.get('X-Atelier-Job') || ''
    }
    while (!signal.aborted && !finished) {
      try {
        response ||= await fetch(`/api/v1/jobs/${jobId}/events?after=${sequence}`, { headers: { Accept: 'text/event-stream' }, signal })
        if (!response.ok) throw new Error(`恢复 Agent 连接失败：HTTP ${response.status}`)
        await readAgentFrames(response, (raw, id) => {
          if (id && id <= sequence) return
          if (id) sequence = id
          const event = raw as AgentEvent & {status?: string; error?: string}
          if (event.type) { onEvent(event); if (event.type === 'done') finished = true }
          if (event.status && ['succeeded','failed','cancelled','interrupted'].includes(event.status)) {
            finished = true
            if (event.status !== 'succeeded') onEvent({type:'notice',message:event.status === 'cancelled' ? '任务已停止' : event.error || '任务已中断，请检查最后保存的回复'})
          }
        })
        // A completed job is not proof that this subscriber received its tail.
        // Reconnect from the last event ID until done/terminal status is delivered.
        if (!finished) throw new Error('流连接提前结束')
      } catch (error) {
        if (signal.aborted || !jobId || retries >= 4) throw error
        retries++
        onEvent({type:'notice',message:`连接中断，正在恢复原任务（${retries}/4）…`})
        await new Promise<void>((resolve,reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException('已停止','AbortError')) }
          const timer = window.setTimeout(() => { signal.removeEventListener('abort',abort); resolve() }, Math.min(800 * 2 ** (retries-1), 5000))
          signal.addEventListener('abort',abort,{once:true})
        })
      }
      response = null
    }
  } finally { signal.removeEventListener('abort',stop) }
}
