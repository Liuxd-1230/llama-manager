# Design Spec — Issue #8

## 问题分析

### 1. SVG图标过大（AC-1）
**根因**：33个`<symbol>`内嵌了`<svg width="24" height="24">`子元素。外层CSS `.icon{width:16px}` 设置的是外层svg尺寸，但内层svg的width/height创建了独立视口，覆盖CSS。

**修复方案**：正则替换，删除`<symbol>`内的`<svg ...>`开始标签和对应的`</svg>`结束标签，只保留path/circle/line等图形元素。

### 2. 暗色模式（AC-2）
**根因**：需实际检查。CSS变量定义正确，可能是：
- 某些JS动态生成的innerHTML未使用变量
- 或用户反馈的是其他问题（如首屏闪烁）

**修复方案**：审查所有JS中硬编码颜色，确保全部使用CSS变量。

### 3. 优化器WS不重连（AC-3）
**根因**：`app.js:562` 的 onclose 只置null不重连。

**修复方案**：添加 `setTimeout(connectOptimizeWS, 3000)` 重连逻辑。

### 4. api()错误处理（AC-4）
**根因**：直接 `.json()` 无错误检查。

**修复方案**：包装 try/catch，返回 `{error: message}`。

### 5. WS指数退避（AC-5）
**修复方案**：引入退避变量，3s→6s→12s→24s→30s(max)，成功时重置。

### 6. 空catch（AC-6）
**修复方案**：改为 `console.warn`。

## Changes Manifest
