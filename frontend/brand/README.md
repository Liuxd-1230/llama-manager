# Atelier 品牌资源

标志轮廓来自用户的 ZIP，保持路径不变。atelier-mark.svg 是主标志，atelier-wordmark.svg 是字标，atelier-lockup.svg 是组合，atelier-construction.svg 是完整构造。字标使用嵌入的开源 Newsreader 可变字体，编辑时仍为 SVG 文字。

构造各图层都有独立 ID。尺寸单位对应 SVG 坐标：宽 163、高 148、半宽 81.5；构造圆为外接框中心 (81.5,74) 到角点的距离约 110.083。

矢量轮廓的唯一源是 src/brand/mark.json；运行 npm run generate:brand 导出主标志、favicon、组合构造图与 180/192/512 PNG。atelier.ico 为同一 512 PNG 的多尺寸格式转换，可用于 Windows 快捷方式；本项目没有原生桌面安装器，不会修改现有系统快捷方式。

动画见 src/components/BrandConstruction.tsx 与同名 CSS Module：首页和关于页均可显式重播，约 2.9 秒，自动只播放一次。导航悬停或键盘聚焦显示局部构造线，任务标志只按真实状态反馈，均不空闲循环。减少动态效果直接显示最终状态。风景 WebP 来自用户 Demo，来源见同名 JSON sidecar 与项目 licenses/atelier-user-assets.md。
