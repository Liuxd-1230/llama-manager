export type ItemLabel = "object" | "character" | "text";
export type CanvasKind = "single" | "multi_panel" | "collage";
export type DocKind = "layout" | "caption";
export type DepthTier = "auto" | "fg" | "mg" | "bg";
export type Anchor = "world" | "screen" | "backdrop";
export type BBox = [number, number, number, number];

/** 3D 体块：远近（1 = 基准深度，越大越远）、厚度（相对框宽）、朝向（度，0 = 正对初始机位） */
export interface Body {
  z: number;
  thickness: number;
  yaw: number;
  anchor: Anchor;
}

export interface LayoutItem {
  shape?: "rectangle" | "ellipse" | "polygon";
  points?: [number, number][];
  label: ItemLabel;
  caption: string;
  bbox: BBox;
  text?: string;
  tags?: string[];
  palette?: string[];
  // ---- 编辑器元数据（编译时剥离）----
  id: string;
  name?: string;
  hidden?: boolean;
  locked?: boolean;
  depth?: DepthTier;
  color?: number;
  body?: Body;
  /** 成组：同一个组 id 的框视为一体（移动、镜头调度时不分离） */
  group?: string;
}

export interface Camera {
  enabled: boolean;
  orbit: number;
  pitch: number;
  roll: number;
  distance: number;
  fov: number;
  pan_x: number;
  pan_y: number;
  pan_z: number;
}

export type CameraKey = Exclude<keyof Camera, "enabled">;

export interface PerspectiveSettings {
  enabled: boolean;
  mode: 1 | 2 | 3;
  horizon_y: number;
  vp1_x: number;
  vp2_x: number;
  vp3_x: number;
  vp3_y: number;
  show_grid: boolean;
  auto_scale: boolean;
  source?: "manual" | "boxes" | "image";
}

export interface PromptOptions {
  depth: boolean;
  perspective: boolean;
  camera: boolean;
  /** 编译时把灯光描述追加到整体描述（默认开） */
  lighting: boolean;
}

export type LightRole = "key" | "fill" | "rim" | "bg" | "practical";

/** 一盏灯。方向用和机位相同的约定：azimuth 像环绕角（0 = 从初始机位一侧照向主体，正值 = 右侧，180 = 背后），elevation 像俯仰（正 = 从上往下照） */
export interface Light {
  id: string;
  role: LightRole;
  enabled: boolean;
  azimuth: number;
  elevation: number;
  /** 强度 0–2，1 = 正常 */
  intensity: number;
  /** 色温（K）；为 null 时用 color */
  kelvin: number | null;
  color: string;
  /** 0 = 硬光，1 = 柔光 */
  softness: number;
}

export interface Lighting {
  enabled: boolean;
  /** 当前套用的预设 id；手动改了灯位就清空（显示为自定义） */
  preset: string;
  lights: Light[];
  /** 环境光 0–1 */
  ambient: number;
  ambient_kelvin: number;
  /** 氛围效果 id（体积光、薄雾…） */
  extras: string[];
  /** 补充描述，原样追加 */
  note: string;
  /** true：灯光方位相对机位（转机位时灯跟着转）；false：灯固定在场景里 */
  follow: boolean;
}

export interface LayoutSummary {
  caption: string;
  meta?: string[];
  canvas?: CanvasKind;
  palette?: string[];
}

export interface LayoutDraft {
  width: number;
  height: number;
  bbox_coord_space: "abs";
  bbox_format: "xyxy";
  summary: LayoutSummary;
  items: LayoutItem[];
  perspective?: PerspectiveSettings;
  prompt_options?: PromptOptions;
  camera?: Camera;
  lighting?: Lighting;
}

export interface CaptionDraft {
  caption: string;
  segments?: PromptSegment[];
}

export interface PromptSegment { id: string; name: string; text: string; locked?: boolean; translation?: string }

export interface Doc {
  asset_ids?: string[];
  compile_target?: "plain" | "moss" | "anima";
  kind: DocKind;
  layout: LayoutDraft;
  caption: CaptionDraft;
}

export interface Page {
  id: string;
  series_id: string;
  name: string;
  sort: number;
  doc: Doc;
  created_at?: string;
  updated_at?: string;
}

export interface Series {
  id: string;
  name: string;
  sort: number;
  pages: Page[];
}

export interface Revision {
  id: string;
  page_id: string;
  source: string;
  summary: string;
  created_at: string;
  doc?: Doc;
}

export interface Session {
  id: string;
  series_id: string;
  title: string;
  closed: number;
  summary: string;
  protocol: string;
  created_at?: string;
  updated_at?: string;
}

export interface Step {
  name: string;
  label?: string;
  brief?: string;
  ok: boolean;
  result?: string;
  created?: boolean;
  page_id?: string;
}

export type ProposalStatus = "pending" | "accepted" | "rejected" | "partial";

export interface Proposal {
  page_id: string;
  page_name: string;
  base: Doc;
  proposed: Doc;
  summary: string[];
  status: ProposalStatus;
  applied?: Doc;
}

export interface Ask {
  question: string;
  options: string[];
  multi: boolean;
}

export interface MessageMeta {
  page_id?: string;
  selection?: string[];
  skill_ids?: string[];
  attachments?: string[];
  quick?: string | null;
  steps?: Step[];
  proposals?: Proposal[];
  ask?: Ask | null;
  model?: string;
  error?: string | null;
  stopped?: boolean;
  reasoning?: string;
}

export interface Message {
  id: string;
  session_id: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  meta: MessageMeta;
  created_at?: string;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  width?: number | null;
  height?: number | null;
}

export interface ArchiveItem {
  id: string;
  title: string;
  category: string;
  kind: DocKind;
  doc: Doc;
  prompt: string;
  created_at?: string;
  updated_at?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  default_model: string;
  models: string[];
  enabled: boolean;
}

export interface AppSettings {
  provider_id: string;
  provider_name?: string;
  providers?: ProviderInfo[];
  api_key_set: boolean;
  model: string;
  vision_model: string;
  fallback_models: string;
  temperature: number;
  agent_protocol: "auto" | "tools" | "tags";
  context_turns: number;
  prompt_prefix: string;
  negative_prompt: string;
}

export type SkillKind = "caption" | "layout" | "context";

export interface Skill {
  id: string;
  name: string;
  kind: SkillKind;
  builtin: boolean;
  description: string;
  system_prompt: string;
  updated_at?: string;
}

export interface SkillsState {
  skills: Skill[];
  active: Record<SkillKind, string>;
}

export interface CompileResult {
  prompt: string;
  checks: string[];
  prefix: string;
  negative: string;
  source_doc?: Doc;
  source_hash?: string;
  asset_snapshot?: Record<string, unknown>[];
}

export interface ResolutionTemplate {
  name: string;
  width: number;
  height: number;
}

export const RESOLUTIONS: ResolutionTemplate[] = [
  { name: "方形", width: 1024, height: 1024 },
  { name: "竖图 2:3", width: 1024, height: 1536 },
  { name: "横幅 3:2", width: 1536, height: 1024 },
  { name: "横图 5:3", width: 1280, height: 768 },
  { name: "宽屏 16:9", width: 1920, height: 1088 },
  { name: "竖屏 9:16", width: 1088, height: 1920 },
  { name: "小方", width: 768, height: 768 },
];

export const LABEL_TEXT: Record<ItemLabel, string> = { object: "物体", character: "角色", text: "文字" };
export const ANCHOR_TEXT: Record<Anchor, string> = { world: "场景", screen: "贴屏", backdrop: "远景板" };
export const DEPTH_TEXT: Record<DepthTier, string> = { auto: "自动", fg: "前景", mg: "中景", bg: "背景" };
