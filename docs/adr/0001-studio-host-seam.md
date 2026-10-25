# ADR-0001: studio 宿主 seam —— 控件统一宿主语言,颜色唯一跨界点是 remap 派生层

日期:2026-10-26
状态:已接受

## 背景

MOSS Prompt Studio(v2.4,无上游同步)被吸收为第六个工作区「提示词工坊」。集成后的 9 个提交反复修同一类问题:studio 自带第二套 token 词汇与 49+20 个硬编码颜色、`html/#root/scrollbar` 等越界选择器、与宿主并存的 UI 原语(两套 Switch/Modal、两套 Markdown、两套 toast)。未来的架构评审看到这些"重复"会再次提议合并 —— 本 ADR 记录已定边界,避免重提。

## 决策

1. **`.studio-root` 是唯一 seam。** studio 的选择器全部圈在自身作用域内;高度链、滚动条、焦点环、box-sizing 不再影响宿主(stylesGuard 钉住"无裸 `::-webkit-scrollbar`")。
2. **颜色只经 remap 派生层跨界。** studio 颜色的唯一定义点是 base.css 的 `.studio-root` token 块:中性色 `color-mix` 派生自宿主 token(随主题自动翻转,不跟宿主 accent);状态色(`--warm/--ok/--err`)与画布/舞台色为 studio 自有常量。app.css 零颜色字面量。派生值与手调值不可接受时,进带注释锚点的**覆盖清单**,不为个别值恢复整套手写暗色块。
3. **交互控件统一宿主设计语言。** ui 原语迁入 `src/components/kit/` 共享;studio 页面与宿主页面消费同一份 kit。控件质感一律扁平 + 发丝线:渐变、刻度纹理、凸起/内凹阴影不在控件上使用。
4. **编辑性表面保留工坊性格。** 3D 画布、排版、布局、舞台色(`--stage-*/--dark-*/--mark/--wheel`)不受第 3 条约束 —— 工坊的气质由内容表面承载,不靠控件质感。

## 保留的"看似重复"(有意为之)

- **toast 体系两套并存**:studio 的 toast 带 `ok/err/info` 三种形态,宿主 toast 是无形态单样式。强行合并会让宿主的 interface 为 studio 变宽(变浅);studio toast 渲染在 `.studio-root` 内,不越界。
- **Markdown 渲染器两套并存(暂缓合并)**:同栈但 CSS 上下文不同(chat 气泡 vs 工坊面板),合并的回归面大。后续若合并,须独立任务单独验收。

## 后果

- 主题调整从"扫 8 个文件追字面量"变为:改宿主 tokens.css 一处,studio 自动跟随;不接受的派生值进覆盖清单并注明理由。
- 加第四种状态色或新控件 → 改 remap 层或 kit 一处。
- `stylesGuard.test.ts` 是本 ADR 的执行机制:app.css 零颜色字面量;base.css 字面量仅存于 remap 块与覆盖清单;无裸滚动条选择器。
