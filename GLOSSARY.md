# Glossary

本仓库的领域与架构词汇。架构评审、ADR 与代码注释使用同一套名字,不再另造同义词。

## 主题与样式

- **宿主 token(host token)** — `src/styles/tokens.css` 定义在 `:root` 上的设计变量(`--bg/--text/--line/--accent…`),随 `data-theme` 与 `data-accent` 翻转。全仓颜色的最终来源。
- **remap 派生层(remap layer)** — `frontend-src/src/features/studio/styles/base.css` 顶部的 `.studio-root` token 块,是 studio 颜色的**唯一定义点**:中性色用 `color-mix` 从宿主 token 派生(明暗两主题各得其所),状态色与画布/舞台色为 studio 自有常量。studio 页面样式(app.css)只消费这里的变量,不出现颜色字面量(stylesGuard.test.ts 钉住此不变量)。
- **覆盖清单(escape-hatch list)** — remap 派生层末尾带锚点注释的获准块。当派生值与手调值不可接受时,按主题在此覆盖个别 token,每条注明理由;初始为空。
- **共享控件库(shared kit)** — `src/components/kit/`,全仓交互控件(Switch/Seg/Popover/Modal/Dial/NumField… )的唯一定义点,统一宿主设计语言(扁平、发丝线、无拟物质感)。studio 页面与宿主页面消费同一份 kit;见 ADR-0001。

## 引擎与配置

- **引擎(engine)** — 可被启动的推理后端,共三种:`llama.cpp`(llama-server)、`kvmem`(llama-kvmem-server,GGUF + KV 虚拟化)、`ninfer`(ninfer-kvmem-server,.ninfer 产物)。引擎差异(二进制、目录回退、payload 形状)属于后端知识。
- **档案(profile)** — 一套完整的推理配置(JSON,存于 `~/llama-manager/config/`),含引擎、模型路径与引擎专属参数;同一时刻恰有一个当前档案。
- **检索块(retrieval block)** — KVMem 与 NInfer 共有的一组参数(`sink_tokens/recent_tokens/lrfu/lrfu_lambda/lrfu_top_frac/score_agg`),决定 KV 虚拟化时如何保留上下文。

## 估算

- **VRAM 估算器(estimator)** — 前端纯函数 `frontend-src/src/utils/vram.ts`:按引擎(模型几何 + 实测系数)估算显存/内存占用,双消费方(配置页、模型卡片)。模型几何(GGUF 头/.ninfer 清单)由后端读出经 `model_meta` 下发;拿不到时回退到本机实测系数(nvidia-smi 差值,记录在源码注释与 `vram.test.ts` 的断言里)。`SAFE_BUDGET_GB = 7.4` 是 8GB 卡的过载阈值。
