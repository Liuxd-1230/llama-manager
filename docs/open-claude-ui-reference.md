# open-claude-ui 实际参考记录

本记录补于本轮源码核对。此前声称“已看过该项目”缺少依据；本记录不追溯证明此前工作。设计最高准则仍是根目录 `DESIGN.md`，产品方向以用户批准的 Atelier 方案为准。

来源：[Caho1/open-claude-ui](https://github.com/Caho1/open-claude-ui)，固定提交 [`c1f923ae0051a871941b98a0e2e3183a545e6a85`](https://github.com/Caho1/open-claude-ui/tree/c1f923ae0051a871941b98a0e2e3183a545e6a85)。这是社区项目；其关于 Claude 内部实现、版本和物理参数的说明是作者陈述，未独立核实，不作为官方规范。

## 本轮读取与取舍

下列路径均基于上述提交，已读取实际实现：

| 文件 | 观察 | Atelier 中的落点 |
|---|---|---|
| `code-examples/cds-theme.css`、`CdsButton.tsx` | 表面明度、填充与透明按钮减少嵌套边框 | `components/kit/ui.module.css`：次要按钮填充、图标按钮透明悬停；沿用 Atelier 色彩、中文字体与对比度 |
| `code-examples/ChatComposer.tsx` | composition 状态、原生 isComposing 和 keyCode 229 共同处理输入法 | 独立实现 `hooks/useImeGuard.ts`，覆盖普通对话、创作 Agent 和相关快捷键 |
| `code-examples/useClaudeScrollPinning.ts` | 用户滚动后释放吸底，接近底部重新跟随；区分用户输入与程序滚动 | 独立实现 `hooks/usePinnedScroll.ts`，40px 阈值、150ms 冷却、120px 返回入口；另处理隐藏面板恢复与尺寸变化 |
| `code-examples/SegmentedControl.tsx` | 选中背景随选项几何位置变化 | `components/kit/SegmentedControl.tsx`：160ms 位移，方向键/Home/End，减少动态效果；用于创作视图与出图视图 |
| `code-examples/ConfirmationDialog.tsx` | 注释提出焦点约束，但所读组件未完整实现 Tab 焦点锁定 | 保留 Atelier 的焦点锁定，并修复嵌套弹窗只由最上层接收键盘与恢复焦点 |
| `code-examples/ClaudeMotionPresets.ts`、`ThinkingAccordion.tsx` | 不同交互使用不同节奏；部分弹簧参数作者明确标为自行设计 | 采用按任务区分节奏的思路，避免参数控件过冲；不将参数称作官方数值 |
| `code-examples/McpToolDecisionCard.tsx` | 工具来源、参数、状态、结果分层，失败与拒绝单独表达 | 对照现有 MCP 配置和 Agent 调用记录；未移植该卡片，也未引入其“始终允许”授权模型 |
| `docs/claude-components-storybook.html` | 实际在本机浏览器渲染，检查表面、输入区和控件展示 | 参考截图 `.impeccable/review/open-claude-ui-reference.png`；展示页自身的模拟数据与宣传说明不作为业务验收 |

采用的是明确的交互与层级细节。Λ 标志、Folio 创作视觉、Newsreader 展示文字、真实创作预览以及项目/系列/分页结构由 Atelier 自身内容和任务决定。没有打包参考项目的字体、品牌图形、React 组件或整套主题。

原 MIT 许可保存在 `licenses/open-claude-ui.txt`，第三方来源列入根目录 `THIRD_PARTY_NOTICES.md`。缓存源码与实际截图位于被忽略的 `.impeccable/`，可在本机复核；固定提交链接提供可重取来源。
