# Atelier 设计参考卡

根目录 `DESIGN.md` 是用户维护的设计原则；本卡只记录 Atelier 已落地的视觉选择与实现证据。

## 已实现的视觉语言

- **产品与任务**：中文、本地优先的 Windows 模型与创作工作台。主路径是下载、配置、成稿、构图、编译、生成、保存和复用。ComfyUI 是可选的外部连接；界面展示连接与任务状态，产品不管理它的生命周期。截图用于观察视觉状态；真实 KVMem 与 ComfyUI 结果以 `docs/atelier-validation.md` 中的链路记录为准。
- **主视觉**：温润纸面、石墨文字和陶土强调色，结合克制的编辑式排版。当前品牌抓手是用户提供的几何 A；首页把它与横向风景拼贴、真实坐标构造线和同基线字标组合成轻构成作品。项目缩略图和诚实空状态仍可复用 Folio 开放纸张框；此前的 Folio 曾以 Lambda 形作为内部图案；本轮已替换为几何 A。Lambda 仅作为历史参考，不再用于当前标志系统。Claude 的登录页与 Anthropic 官网曾作为视觉参考；Claude 登录后工作台未能查看，不把它当作已验证参考。Linear 提供列表秩序，Raycast 提供就近操作的参考。
- **颜色**：浅色画布 `#f7f6f2`、凸起表面 `#fdfcf8`、主文字 `#242620`、次文字 `#62645d`、辅助文字 `#6c7066`、陶土强调 `#af563f`。深色画布 `#1c1c1b`、表面 `#242422`、主文字 `#eceee6`、次文字 `#bdc2b6`、陶土强调 `#df967b`。蓝、绿、黄、红承担链接和状态语义；紫罗兰、海洋蓝、琥珀是用户可选的强调色主题。
- **字体**：展示字体为 Newsreader Variable / Noto Serif SC Variable；正文与中文操作文字为 Inter Variable / Noto Sans SC Variable；路径和数值使用 IBM Plex Mono。字体通过 `frontend-src/src/main.tsx` 导入并随前端构建打包。展示衬线用于品牌和少数标题，不扩展到工具标签。
- **骨架**：桌面侧栏 190px、页头 68px。390px 窄屏使用 60px 顶栏、底部导航和设置入口；六个主工作区为工作台、创作、模型、下载、素材、对话，设置由独立入口打开。内容按任务重排，不缩小整张桌面页面。
- **密度与版式**：工作台以非等宽的近期项目区与较窄的运行/任务区开场；近期项目行按保存的真实文稿文本或构图形状生成缩略图。模型、下载、素材使用对齐列表和表格；成稿、构图与出图让当前内容或画布占主位，属性和 Agent 作为辅助面板。出图默认显示结果预览，节点图由用户切换查看。空状态直接说明下一步，不伪造作品或运行数据。
- **形状与反馈**：页面骨架平直、细线分隔；普通 kit 按钮圆角 6px 并以填充表面呈现，图标按钮默认透明且只在悬停时出现底色；输入框和面板为 4px，弹窗为 10px，强调空状态卡为 8px。浅深主题均以色面和细边界建立层次，弹窗使用 `--shadow-shell`，通知使用 `--shadow-panel`。共享操作动效基准为快速反馈 140ms、菜单 190ms、面板 260ms、空间重排 340ms；少量签名动画保留各自时值。所有动效遵循系统或显式减少动态偏好。
- **输入与滚动**：共享分段控件支持左右方向键以及 Home/End。Chat 与 Agent 共用组合输入状态/229 键码守卫，并尊重读者主动滚动：输入冷却 150ms、距离底部超过 40px 时释放吸底、离底超过 120px 时显示“回到最新”入口。程序滚动使用 `behavior: auto`；聊天消息区也显式关闭全局平滑滚动。浏览器的合成 composition 事件有覆盖，不据此宣称已完成人工 Windows 输入法全验收。

## 页面意图

| 页面 | 主任务与视觉焦点 |
|---|---|
| 工作台 | 接续真实项目、作品和任务；编辑式开场后进入内容。 |
| 创作·成稿 | 展示可读文稿、固定片段、待确认提案与 Agent；窄屏可切换编辑器和 Agent。 |
| 创作·构图 | 画布优先，属性和 Agent 支持镜头、形状与灯光操作。 |
| 创作·出图 | 默认以结果预览为主视图，切换后查看工作流节点；呈现参数、已保存结果与任务状态。 |
| 模型 | 稳定档案行、可用资源估算与运行操作；配置和日志作为相关二级页面。 |
| 下载 | 搜索、文件表格、保存位置和真实进度/错误。 |
| 素材 | 可检索的文本与作品列表；存在真实图片时用图片形成焦点。 |
| 对话 | 保留流式阅读、回答候选、搜索和附件；导航不应丢失运行中的本地状态。 |
| 设置 | 连接、创作偏好、外观和引擎维护；秘密值以空白与配置状态呈现。 |

## 代码与截图依据

- 色彩、字体、半径、阴影和动效定义于 `frontend-src/src/styles/tokens.css`；全局字体、焦点与 reduced-motion 行为见 `frontend-src/src/styles/global.css`。
- 外层导航与响应式尺寸见 `frontend-src/src/App.module.css`；工作台和资源页见 `frontend-src/src/features/atelier/atelier.module.css`；创作面板色彩映射见 `frontend-src/src/features/studio/styles/base.css`。
- 普通按钮/输入/面板/弹窗规范见 `frontend-src/src/components/kit/ui.module.css`；最顶层弹窗的焦点循环与焦点归还见 `frontend-src/src/components/kit/Modal.tsx`；共享分段控件与键盘行为见 `frontend-src/src/components/kit/SegmentedControl.tsx`。
- 对话与 Agent 使用 `frontend-src/src/hooks/useImeGuard.ts` 和 `frontend-src/src/hooks/usePinnedScroll.ts` 共用输入法守卫及读者释放吸底逻辑；对话消息滚动行为见 `frontend-src/src/features/chat/chat.module.css`。
- Atelier 页面边界由 `frontend-src/src/features/atelier/OverviewPage.tsx`、`DownloadsPage.tsx`、`AssetsPage.tsx`、`Jobs.tsx`、`ProjectBar.tsx` 承担；后端工作记录可按 kind 和 page_id 过滤。细节见 `docs/atelier-architecture.md`。
- 品牌 SVG 见 `frontend-src/src/components/AtelierBrand.tsx` 和 `AtelierBrand.module.css`；项目文本/构图缩略图见 `frontend-src/src/features/atelier/ProjectPreview.tsx`；图像结果默认视图与节点切换见 `frontend-src/src/features/studio/components/ComfyWorkspace.tsx`。
- `.impeccable/review/atelier-production-home.png`、`creative-成稿-light-1440x900.png`、`chat-dark-931x820.png` 和 `chat-light-390-1440x900.png` 是本轮完整 E2E 重录的关键布局证据；其余工作区和主题截图按页面与 `*-light-*`、`*-dark-*` 命名。
- `docs/atelier-validation.md` 记录真实 KVMem GGUF 启动与对话、翻译、Anima 语义编译、视觉 MMProj 反推，以及已有 ComfyUI MOSS 工作流的 512×512 两步图像回传和浏览器呈现。这次出图验证链路，不作为质量基准；其他引擎不算本轮真实启动通过。
- `docs/open-claude-ui-reference.md` 记录实际读取的 `Caho1/open-claude-ui` 固定提交 `c1f923ae0051a871941b98a0e2e3183a545e6a85` 与仅采纳的交互启发；它是社区参考，不是官方 Claude 规范。
- 输入法覆盖包含浏览器合成 composition 事件，不等同人工 Windows 输入法完整验收。截图夹具不证明线上用户数据或模型身份；真实链路结论以验证记录为准。

## 稳定规则

- 工作表面保持安静，陶土色用于关键动作、选中态和少量标题强调，不把整页染成强调色。
- 项目缩略图预览保存的文稿文本或构图，不使用虚构作品图。几何 A 是当前品牌标志；Folio 开放纸框可用于项目和空状态。旧 Lambda 表述是历史资料，不应带入新界面。
- 中文功能文字优先保证清晰；衬线展示字体只用于品牌和选择性标题，路径、代码及测量值用等宽字体。
- 桌面和窄屏维持相同的信息优先级。窄屏把六个主入口放入底栏并保留设置入口，创作页提供编辑器/Agent 切换。
- 出图页默认显示结果预览，工作流节点是显式切换的第二视图。
- 几何 A 默认静态呈现；悬停或键盘聚焦展示测量线，任务进入工作状态时描边播放一次。减少动态时构造保持完整、任务状态仍清楚。
- 普通操作按钮保持填充表面与 6px 圆角，纯图标动作保持轻量；表单值使用细描边 4px 输入面，弹窗采用 10px 外形并把键盘焦点约束在最上层。
- 分段控件保留方向键与 Home/End 操作。对话和 Agent 只在用户仍贴近底部时跟随新内容，离开底部时提供返回最新入口；输入法组合期间快捷键不得误触发。
- 真实作品可成为视觉焦点；没有作品时保留诚实空状态，不用占位图片、虚构模型名或编造读数填满画面。
- 外部 ComfyUI 是外部依赖，任务状态必须来自实际链路；真实 MOSS 链路测试已通过，但低步数截图不代表质量基准。


## 本轮构成与截图依据（2026-10-27）

历史规则曾将完整构造限制在工作台首页；本轮修订为首页与“关于 Atelier”都可展示同一构造，且关于页提供显式重播。首页首次进入自动播放约 2.9 秒，之后停留；完整、精简、关闭偏好控制装饰强度，不限制可重播的关于页。

本轮代表性浏览器截图位于 `.impeccable/review/upgrade-final/`：`home-light-1440.png`、`home-dark-390.png`、`chat-dark-390.png`、`draft-dark-1920.png`、`appearance-light-390.png`。品牌与实测值见 `frontend-src/src/components/BrandConstruction.tsx`；共享动效偏好见 `frontend-src/src/components/VisualPreferences.tsx`。


## 构造、动效与空间收尾记录

品牌路径的唯一数据源是 `frontend-src/src/brand/mark.json`；`AtelierBrand.tsx` 从中读取几何 A，`scripts/generate-brand.mjs` 以它导出 SVG、favicon、组合图及 180/192/512 PNG，ICO 由 512 PNG 转换。Folio 已从旧 Lambda 内形替换成同一几何 A。项目没有原生桌面安装器；因此这里不声称改变 Windows 系统快捷方式。

品牌动效分为三个清晰状态：导航、Folio 与工作状态图标默认静态；悬停或键盘聚焦时测量线逐渐显现；任务进入工作状态时描边只播放一次。完整的品牌构造作品在工作台首页首次进入播放约 2.9 秒，之后保持完成态；“关于 Atelier”展示同一构造并允许重播。系统 `prefers-reduced-motion` 和显式减少动态偏好会关闭动画或过渡，不会隐藏标志、测量信息或任务状态。

日常操作动效按 `tokens.css` 分为快速反馈（140ms）、菜单（190ms）、面板（260ms）和空间重排（340ms）。创作空间在 1100px 阈值切换 Agent 与画布的紧凑布局；主布局采用真实 grid track 重排。对话字号体系为 12/14/15/18px，阅读正文为 15px，并保持易读行高。

`.impeccable/review/polish-after/metrics.json` 记录：Agent 打开时主区域宽度 1241→841，关闭时 841→1241；导航宽度 190→64；快捷切换成功；桌面非抢焦点开关激活时，原编辑输入节点保留焦点；菜单键盘焦点通过。该指标不代表关闭 Agent 后的焦点归还，关闭焦点归还仍由新增 E2E 验收。减少动态测试记录 `0s` 且品牌动画计数为 0。工作台、对话、设置、关于及资源等浅色/深色视口的溢出检测均为 false，错误列表为空。这些是该轮浏览器检查结果，不代表原生安装器行为。

证据文件：`frontend-src/src/styles/tokens.css`、`frontend-src/src/components/AtelierBrand.tsx` 与模块样式、`frontend-src/src/brand/mark.json`、`frontend-src/scripts/generate-brand.mjs`、`frontend-src/src/features/studio/StudioPage.tsx` 与 `styles/refinement.css`、`frontend-src/src/hooks/useCompactWorkspace.ts`、`frontend-src/src/components/SettingsDrawer.tsx`、`ConversationSurface.tsx` 与样式，以及 `features/chat/chat.module.css` 和 `features/atelier/atelier.module.css`。


## 真实使用精修（2026-10-27）

首页采用简洁的小幅品牌板，默认不自动完整构造；完整构造由“查看构造/重播”与关于页提供。保留同一几何 A、用户背景及已有强调色偏好。项目、作品和任务是日常首页的重心。

长对话以约800px正文宽度、统一段落与列表节奏呈现。Agent共用对话Markdown与代码控件，保留工具和提案语义。移动端把会话操作和模型信息分两行。网页目录选择器采用独立路径、列表、按钮行；静态精致不能以覆盖操作区为代价。

文档版本、Agent对话与生成任务分别命名；历史入口的价值由实际预览、恢复或结果访问支持。完整修复、实际模型与公网验证，以及原生窗口尚未验证的边界见 `atelier-reliability.md`。
