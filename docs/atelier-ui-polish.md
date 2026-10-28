# Atelier UI 精修与空间动效 · 2026-10-27

本轮保留产品架构、模型调用和用户数据，精修既有暖白、石墨与陶土视觉体系。按照根 DESIGN.md，实际检查了运行中的 9090，并使用独立数据与 9092 完成有状态回归；修改阶段在 5173 预览，最终整轮浏览器测试针对生产静态资源。

## 改动前观察

- 创作页项目、分页、辅助工具和编译控制同时抢占注意力；960px 时 Agent 落到画布下方。
- 文稿标题下的指导语重复明显操作。品牌副标题、素材宣传语增加操作页噪声。
- Logo 虽已有几何 A，但工坊顶部与 Folio 内部仍保留旧图形，完整构造难以再次访问。
- Agent 缺少显式收放与正文让位；普通对话选项使用 display 切换；设置分类和素材详情缺乏连续展开。
- 设置主题预览与真实暖白/炭灰不一致，强调色色样也与实际变量不同。

## 实现与边界

- 保留项目、分页、文稿/构图/出图、保存状态及主动作；反推、档案、版本、Skills 和创作设置收入“创作工具”。编译输出目标与漫画分格放入“编译选项”。
- 去掉重复引导；文稿以当前页名与分段正文为焦点。保留固定状态、提案确认、参数限制、错误恢复和隐私说明。
- 操作字号角色为 12/14/15/18px；展示排版保留 Newsreader。表单、按钮、焦点、状态与表面引用共用变量，设置色样反映实际主题。
- 桌面 Agent 使用真实 grid track 在 340ms 内收放；编辑器和 Agent 保持挂载。1100px 以下在同一工作区切换，并用 inert 管理不可见面板。属性抽屉与 Agent 互斥。
- 侧栏真实改变列宽；素材详情改变列表空间；素材引用、对话选项、思考/工具内容使用网格高度过渡。菜单有方向、Escape 与箭头键；设置分类共享选中背景并展开内容。支持快速反向与减少动态。
- 几何 A 轮廓唯一来源是 src/brand/mark.json。静态标志、导航悬停/聚焦构造、一次任务描边以及首页/关于页完整重播共享该形状。Folio 内形已替换。SVG/favicon/PNG/ICO 已导出；没有原生桌面安装器，因此没有改动 Windows 已有快捷方式。
- 回归发现 ComfyUI 定时状态轮询可能使手动恢复结果被忽略、待发送参数可能覆盖恢复。已让显式恢复优先于轮询，取消待发送旧值，并在工作流切换时直接保存当前表单值。保留外部服务管理边界。

## 实测

- 最终生产静态资源：Playwright **84/84**；Vitest **63/63**；后端 unittest **142/142**；HF pytest **39/39**。TypeScript、OpenAPI 生成、品牌导出与生产构建通过。首轮失败和定位日志保留，最终通过结果不以重试掩盖。
- 采集 **16 张改动前、92 张改动后**截图。覆盖 1920、1440、1280、960、931、690、390px，深浅主题、文稿、构图、Agent、对话、设置/供应商/外观、下载、模型、素材、记事本、Preset、关于页。截图尺寸保留在文件名与包内 manifest。
- 实际连续采样：Agent 展开时正文 1241→841px，25 个不同整像素宽度；关闭时 841→1241px，38 个不同宽度。侧栏 190→64px，27 个不同宽度。非抢焦点激活时编辑节点保留焦点；关闭 Agent 回到开关、菜单 Escape 回到触发器由 E2E 验证。
- 快速反向稳定；不可见面板不可聚焦；已采集页无横向溢出、无 pageerror。减少动态时主区域 transition-duration=0s、构造运行动画为 0。导航悬停测量线 opacity=.65，构造完成后空闲运行动画为 0。
- 实际视频：Atelier-spatial-motion.webm 约 26 秒，包含 Agent 收放/反向、侧栏、菜单键盘、设置分类、关于页构造和 390px 切换；Atelier-brand-states.webm 记录悬停、聚焦与重播。timeline.json 给出操作时间。
- 检测器本轮目标结果 []。独立视觉复核 disposition: ship，范围仅本轮截图、源代码与动效指标。

正式数据在构建前备份至 `%LOCALAPPDATA%/Atelier-backups/ui-polish-20261027T124655Z`。前后均为 88 个对话、4 页、28 个修订、14 条创作消息；两库 integrity_check=ok，foreign_key_check=0。9090 HTTP 200，受管引擎保持 stopped。没有启停外部 ComfyUI。

本轮没有重跑真实语言模型或 ComfyUI 出图；协议、断流、工具与错误恢复使用隔离测试或受控响应。浏览器合成中文 composition 测试不等于人工 Windows 输入法全面验收。视频与帧采样验证操作连续性，不是全硬件帧率基准。构建仍有入口包超过 500kB 的体积提示。离线评审页只校验文件链接、图片与 ZIP，不声称经过浏览器预览。

## 修改文件

| 范围 | 文件（相对仓库根） |
|---|---|
| 全局与路由 | frontend-src/src/App.tsx、App.module.css、styles/tokens.css、components/kit/ui.module.css、components/kit/primitives.tsx |
| 动效偏好与断点 | frontend-src/src/hooks/useMotionPreference.ts、useCompactWorkspace.ts |
| 品牌 | frontend-src/src/brand/mark.json、components/AtelierBrand.tsx、AtelierBrand.module.css、BrandConstruction.tsx、scripts/generate-brand.mjs |
| 静态品牌与元信息 | frontend-src/public/atelier.svg、atelier.ico、manifest.webmanifest、brand/atelier-mark.svg、atelier-lockup.svg、atelier-construction.svg、atelier-180.png、atelier-192.png、atelier-512.png、brand/README.md、index.html、package.json |
| 创作与 Agent | frontend-src/src/features/studio/StudioPage.tsx、store.ts、styles/base.css、styles/refinement.css、components/TopBar.tsx、CreativePanels.tsx、creative.module.css、AgentPanel.tsx、ComfyWorkspace.tsx |
| 对话与设置 | frontend-src/src/features/chat/ChatPage.tsx、chat.module.css、components/ConversationSurface.module.css、SettingsDrawer.tsx、SettingsDrawer.module.css |
| 资源工作区 | frontend-src/src/features/atelier/AssetsPage.tsx、OverviewPage.tsx、Jobs.tsx、ProjectBar.tsx、AboutPage.tsx、atelier.module.css |
| 验证与开发 | frontend-src/e2e/atelier-polish.spec.ts、atelier.spec.ts、app.spec.ts、vite.config.ts（可指定隔离 API）；OpenAPI 与 src/generated/api.ts 重新生成 |
| 交付 | frontend/ 生产静态资源、docs/atelier-design.md、本报告、docs/atelier-validation.md、.impeccable/review/polish-* 证据与采集脚本 |

此清单针对本轮，不等同仓库当前全部未提交改动；此前实施中的其他源文件和数据保持保留。
