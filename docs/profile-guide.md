# 档案创建指南（人机协作）

供 AI 代理与用户协作创建/调整推理档案使用。所有操作走产品 HTTP API（默认 `http://127.0.0.1:9090`），不要直接改 `~/llama-manager/config/*.json`。

## 档案 = 什么

一条档案是一个完整推理配置：引擎 + 引擎目录 + 模型文件 + mmproj + 启动参数（基础/KVMem/NInfer/MTP）+ 采样 + 聊天模板 + 系统提示词 + 监听地址。三种引擎：`llama.cpp`（llama-server，GGUF）、`kvmem`（llama-kvmem-server，GGUF+KV 虚拟化）、`ninfer`（ninfer-kvmem-server，**.ninfer 工件**，KVMem v0.18.0 统一包）。

**引擎目录留空 = 用内置包**：`<项目根>/engine/<包名>/` 下解压的引擎包会被自动发现（按包内 `VERSION` 取最高版本），`llama_cpp_dir` 不必填。当前内置 `kvmem-v0.18.0-ninfer-windows-rtx40-sm89`（本机 RTX 4060 Laptop = sm89；换显卡就解压对应包，旧包删掉即可）。`engine/` 已在 .gitignore 里，不入库。


## 标准创建流程（API 序列）

```python
import httpx
c = httpx.Client(timeout=120)
BASE = 'http://127.0.0.1:9090'

cfg = c.get(f'{BASE}/api/config').json()          # 1. 读当前配置做底板
cfg.update({...})                                  # 2. 改档案级字段
r = c.post(f'{BASE}/api/config/save-as', json={'name': '<档案名>', 'config': cfg})   # 3. 保存（save-as 即成为当前）
c.post(f'{BASE}/api/profiles/launch', json={'name': '<档案名>'})                      # 4. 启动（自动停旧）
# 5. 轮询 {引擎地址}/health 直到 200
```

只想切换编辑目标不启动：用 `POST /api/profiles/set-current`。

## 字段语义（三引擎对照）

| 字段 | llama.cpp | KVMem | NInfer |
|---|---|---|---|
| `engine` | `"llama.cpp"`，找 `llama-server.exe` | `"kvmem"`，找 `llama-kvmem-server.exe`（根或 bin/） | `"ninfer"`，找 `workers/ninfer/ninfer-kvmem-server.exe`（v0.18 统一包），回退 `engine/ninfer-serve-*.exe`（旧独立包） |
| `llama_cpp_dir` | git 检出或解压根 | KVMem 解压根或其 `bin/` | **留空即用内置包**；或统一包根（含 `workers\ninfer\`） |
| 模型 | `.gguf`（`-m`） | `.gguf`（`-m`） | `.ninfer`（**裸位置参数**，无 `-m`） |
| 上下文 | `basic.ctx_size`（`-c`，占显存） | `kvmem.workspace`（`-c`，逻辑工作区不占显存） | `ninfer.max_context`（`--max-context`，逻辑上限；显存由 B+R 决定） |
| KV 量化 | `basic.kv_cache_quant_k/v` | `kvmem.kv_dtype` | `ninfer.kv_dtype`（交付档 `k8v4`；小池验收只在 k8v4 做过） |
| 思考默认 | `basic.enable_thinking` → `--reasoning on` | `kvmem.enable_thinking` → `--enable-thinking --reasoning-budget` | `basic.enable_thinking` → `--default-reasoning-effort <effort|none>`，档位 `ninfer.reasoning_effort`，上限 `default_thinking_budget` |
| GPU 常驻 | 由 `-c` 决定 | 由 `budget + gen_reserve` 决定 | 由 `ninfer.budget`(B) + `ninfer.gen_reserve`(R) 决定，按 64-token 页向下对齐；`host_kv_mib` 是主机侧配额 |
| 检索常驻窗口 | 无（全量常驻） | `kvmem.sink_tokens` / `recent_tokens`（块对齐，之和 ≤ budget） | `ninfer.sink_tokens` / `recent_tokens`（64-token 页对齐，之和 ≤ budget） |
| 历史加权 LRFU | 无 | `kvmem.lrfu` + `lrfu_lambda` + `lrfu_top_frac` + `score_agg`（**需 v0.17+ 构建**） | 同左，v0.18 统一包原生支持 |
| 批次 | `basic.batch_size/ubatch_size` | `kvmem.batch`（**必须 128**，实测 512 减速一半） | `ninfer.prefill_chunk`（128 的倍数） |
| 投机解码 | `mtp.*`（`--spec-type`） | `mtp.*`（需合并 MTP 头的模型） | `ninfer.spec`（`mtp/dflash/dflash2`）+ `draft_tokens`（≤15）+ `adaptive_mtp` + `ngram_draft_tokens`(≤63)/`ngram_min_match` |


显存账（KVMem，RTX 4060 Laptop 8GB 实测）：**桌面常驻 ~1GB + 权重 5.5GB + CUDA 缓冲 ~0.4GB + (预算+预留) × 25MB/千token（q8_0）或 ~12.5MB/千token（q4_0）**。安全线：总计 ≤ 7.4GB。`basic.ctx_size/threads/parallel/fit/MoE/KV K/V/mmap/...` 在 KVMem/NInfer 引擎下不进命令，不要设置。

## NInfer 引擎专节（KVMem v0.18.0 统一包）

内置包：`<项目根>\engine\kvmem-v0.18.0-ninfer-windows-rtx40-sm89\`，唯一 worker 是 `workers\ninfer\ninfer-kvmem-server.exe`（build 8319e8f-dirty，SHA256 已对过 release 的 `7ec486c0…122806`）。它同时是 NInfer 推理核和 KVMem 分层器，所以检索参数与 `llama-kvmem-server` 共用一套 `--kvmem-*` 词汇。**本包只含 NInfer 后端**，没有 `llama-kvmem-server.exe`——GGUF 路线仍走 `E:\kvmem-prism`。

- **路径必须全英文**：包和 `.ninfer` 模型的完整路径（含用户名、上级目录、文件名）不能含中文字符，否则引擎起不来。
- **工件版本**：需要 NInfer **v3** `.ninfer`。本机现存的 `E:\infer-engine-sm89-20261002\models\bonsai2_27b_ternary_ptq1_native_mtp.ninfer` 魔数是 `NINFER\0\3`（v3 容器）**但加载失败**：`weight/000258: unknown tensor format: ptq1_g128_fp16`——那是 2026-10-02 自建补丁版（上游 0.11.0 + 34 补丁）的私有张量格式，官方只认 `t2_g128_fp16`。不是配置问题，换参数无解。
- **要跑 ninfer 路线必须先解决模型**：要么下作者发布的官方 NInfer v3 工件，要么用 ninfer-all 的 `bonsai2_27b_ternary` 配方从 GGUF 自转（`--model` 需要完整 Qwen3.8-27B HF 检查点取视觉与前端资源、Python 3.11 + PyTorch、且配方校验 PrismML `PQ2_0.gguf` 的 Hadamard 元数据，我们手上是 Heretic v2 `PTQ1_0`，可能过不了 header 校验）。
- **参数面**（v0.18 真实旗标，已用 54 个 token 的完整命令实测被引擎接受）：`--kvmem-budget`(B) / `--kvmem-gen-reserve`(R) / `--kvmem-host-mib`(H) / `--kvmem-sink-tokens` / `--kvmem-recent-tokens` / `--kvmem-sessions`(1..16) / `--kvmem-lrfu` + `-lambda` + `-top-frac` / `--kvmem-score-agg mean|max` / `--kvmem-disk-path` + `-disk-mib` / `--ngram-draft-tokens` + `--ngram-min-match` / `--fast-prefill-kernel` / `--default-thinking-budget`。旧的 `--kv-capacity`、`--host-kv-mib` 和 `NINFER_KV_*` 环境变量**全部作废**，`build_env` 已删。
- **两条硬校验**（启动器已前置拦截，配置页会实时告警）：① B+R ≤ `--max-context`；② sink+recent 按 64-token 页向下对齐后 ≤ B，超了引擎直接拒绝启动。
- **官方默认配方**（16GB 卡验的，8GB 卡要往下压）：ctx 204800、B/R 36864/16384、KV 双 int8、prefill 256、sink/recent 12288/1024、sessions 1、LRFU 开（λ0.5 / top-frac0.9 / max）、自适应 MTP4 + ngram31/12、思考预算 8192、主机 12288MiB、SSD 关。`NinferSettings` 的默认值是按本机 8GB 取的安全档（B/R 8192/8192、sink 4096），不是官方配方。
- **`top-frac` 不是保留比例**：它只控制"本轮允许累加相关性分数的命中范围"，跟保留多少 KV、预算分配都无关；`score-agg max` 是同一 KV head 下各 query head 取最大相关性。
- **SSD 分层是进程内的**：不支持重启恢复，也不能跨后端迁移 KV；`--kvmem-host-mib`/`-disk-mib` 是受管数据配额，不是进程总内存上限。
- **首次启动会标定**：日志 `calibrating routes for nvidia-geforce-rtx-4060-laptop-gpu-sm89` 约 2 分钟，之后读 `%LOCALAPPDATA%\ninfer\device-profiles.json`（schema v2；旧 v1 文件会被跳过并重建）。
- **请求级约束**（chat 代理已处理，勿在别处发）：`top_k` 只收 0..20（40 直接 400）；model 字段省略=当前工件，填错 404——**对话页缓存模型名，档案务必用 `ninfer.model_id` 固定 id（对齐启动器 `qwen3.8-27b`），否则换工件/换启动方式会让已打开的对话页 404**；`chat_template_kwargs` 也被引擎识别但产品统一走 `reasoning_effort`（对话页档位选择器会透传）

### 历史实测（旧独立包 `E:\infer-engine-sm89-20261002`，ninfer-serve-89.exe，2026-10-03）

仅作对照，参数面已作废：数数字 1000/1000 prefill 544 t/s、解码 60.6 t/s、TTFT 2.1s、MTP 接受 88.1%；池 4032(63 页) + 预填块 256 + CUDA Graphs 关是当时 8GB 可用档；环检索靠 `NINFER_KV_WINDOW/KV_RETRIEVE` 环境变量开（日志判据 `kvmem_score: SELECT` 行 ≥1）；层 0 分块不进检索索引（`cannot expose the pre-RoPE key` 警告）是引擎已知性质，不影响召回。


## 实测调优知识（别再重新踩坑）

- KVMem `batch` 必须 128：512 会把解码砍半（29→12 t/s）、prefill 打六折
- **常驻窗口实测（2026-10-14，v0.16.0-rc3-prism.3）**：`--kvmem-sink-tokens 2048 --kvmem-recent-tokens 1024` 配 budget 3072 在 8GB 卡上正常启动、health 200、对话答对——sink/recent 这两个旗标从 v0.16 就有，不必等新包就能用

- KVMem 预算(常驻历史)越小 prefill 越稳：24.5K 预算灌 29K 文档会衰减到 101 t/s，8K 预算稳定 245 t/s
- MTP 收益强依赖内容可预测性：数数/代码 60 t/s，自由文风 32-35 t/s（无 MTP 基线 29）
- MTP 草稿数实测（推荐配置，Heretic + r3 头）：数数 44/55/61（MTP1/2/3），真实文风 34/35/28——**MTP2 是自由文本最优**，MTP3 只在高可预测内容继续加速；ReplaySSM 上游 v0.15 起推荐、master 默认，但实测 prism.3 预编译二进制仅支持 snapshots（`--help` 仅列出 snapshots；传 replay 启动即报 "Record/Fold is not available in this Bonsai build"），等新预编译或源码构建后再切
- 视觉对话：mmproj 留内存（`--no-mmproj-offload`），对话页图片附件以 data URL multipart 发送，视觉请求首 token 含 CPU 编码时间（实测 3.7s）
- 长文档附件 prefill 实测：46K token 文档经 KVMem 分页，首 token 128.8s（约 230 t/s 含检索），埋点召回准确
- KVMem 引擎要 WebUI：`llama_cpp_dir` 指向含 `share/kvmem/ui` 的包根，命令自动带 `--ui-dir/--webui`
- 思考模型 + 小 max_tokens = 空回复（token 被思考吃掉）：对话页思考开关关掉，或放大 max_tokens

## 已验证档案（截至当前）

| 档案 | 引擎 | 模型 | 定位 |
|---|---|---|---|
| `ninfer-bonsai` | NInfer | bonsai2_27b PTQ1 native MTP (.ninfer) | 数数 60.6 t/s、TTFT 2.1s，端口 8095，8GB 默认参数 |
| `hermes-moe` | llama.cpp (Prism) | Qwen3.6-35B-A3B Q4 (16GB) | `--n-cpu-moe 40` 全专家进内存：显存仅 2.9G、内存 14.5G，decode 31 t/s；必须 `mtp.enabled=false`（Prism 对无 MTP 层模型会拒启） |
| `ornith-9b` | llama.cpp | Ornith-1.5-9B Q4_K_M | 全 GPU 6.3G：decode 39 t/s、prefill 1575 t/s、TTFT 0.7s，速度最快档 |
| `bonsai-prism` | llama.cpp (Prism) | Bonsai PTQ1+MTP-r3 GGUF | Prism 自动建 MTP 草稿上下文，无 MTP 头的 GGUF 会拒启 |

三引擎同数据集实测（基础回归集，2026-10-06）：质量均 0.667；平均延迟 KVMem 3.1s < NInfer 4.9s < Prism 11.6s（Prism 的 MTP-r3 模板默认开思考，短回答被推理 token 拖慢，属真实体验）。
| `bonsai-fast` | KVMem | Heretic PTQ1+MTP Q4头 | 日常主力：workspace 32K / 预算 2K / 预留 4K / KV q4_0 / MTP2，数数 55 t/s、文风 32 t/s |
| `bonsai-mtp` | KVMem | 同上 | 长输出日常：workspace 64K / 预算 8K / 预留 4K / KV q8_0，36-57 t/s 视内容 |
| `kvmem-bonsai` | KVMem | Heretic PTQ1（无 MTP） | 长上下文无 MTP 对照 |
| default | KVMem | 同 bonsai-fast | 历史遗留，可清理 |

PrismML fork（`E:\PrismLlma`，短对话极致 651/27.8 t/s）通过系统直接跑或 WebUI 使用，档案指向它时引擎选 llama.cpp。

## 模型文件合并（Bonsai MTP）

`tools/kvmem/bonsai-mtp-graft-heretic.py`（SHA 白名单含官方与 Heretic PTQ1_0；换新底模先算 SHA256 加白名单）。依赖仅 numpy + 源码树自带 `llama.cpp/gguf-py`，无需 CUDA/PyTorch。产出 `-MTP-r3-Q4_0.gguf`（MTP 头 Q4_0，norm F32，866 张量，851 张逐字节校验）。

## 四路线横评（Heretic v2 PTQ1_0，RTX 4060 Laptop 8GB，2026-10-11 实测）

同一模型文件、同一探针（数数字 200 token + 18,480 token 长文埋针 EQ-333→员工33）：

| 路线 | 档案 | 短解码 | 短 prefill | 20K 长文 | 机制 |
|---|---|---|---|---|---|
| NInfer（环+MTP） | `ninfer-bonsai` | **53.3 t/s** | 547 | 34.7s 完成但**针答错**（池 4032，超池 4.6×） | 检索换页 + MTP 投机 |
| KVMem 开 | `bonsai-kvmem-v2` | 32.7 t/s | 248 | 63.6s **答对**（工作区 32K 全覆盖） | KV 虚拟化 |
| KVMem 关=kernel 分支 | `bonsai-kernel` | 34.6 t/s | **619** | **400 拒绝**（c8192 装不下） | 全常驻显存 |
| 旧 PrismLlma | （对照） | 31.1 t/s(bench) | — | 400 拒绝 | 全常驻显存 |

结论：
- **短对话选 ninfer**（MTP 加持快 ~60%）；kernel 分支比旧 PrismLlma 快 14.7%（llama-bench tg128 31.1→35.7），作为 GGUF 路线的免费提速
- **长文档（>8K）必须走 KVMem**：32K 逻辑工作区针准确；ninfer 的 4032 池超池 4.6 倍时数字针**静默答错**——超池题面在 ninfer 上不可信，重要数据请开新对话压回池内或切 KVMem
- **ninfer 上下文缓解实测（2026-10-11）**：池 4032→8192 + 检索取回 8192→16384 后，18.5K 密表三针从 0-1 对提升到 2 对；残留错误是引擎已知的**跨页缝截断**（针行恰压 64-token 页边界，邻页搬回但目标行被切半，如 EQ-333 读成相邻的 EQ-332）——引擎侧问题，只能上报作者或绕开（密表查询用 KVMem）。`ninfer-bonsai` 档案已固化 池 8192/取回 16384（free 446MB，余量健康）
- 纯 llama.cpp（KVMem 关）在 8GB 卡上对这个 5.94GB 模型只撑得起 ~8-16K 上下文，20K 直接拒
- kernel 分支位置：`E:onsai2-small-gpu-windows-x64-cuda12.4-sm86-sm89-ff41412`（sudoingx 构建，含 llama-bench）；MTP 完整收益需官方 lean 文件（8GB 配方 `-c 49152 --spec-draft-n-max 2`）

## 验证清单（创建后必做）

1. `GET /api/profiles` — 新档案在列、`model_exists: true`
2. `POST /api/profiles/launch` — 200，且 60s 内 health 200
3. `nvidia-smi` — 总显存 ≤ 7.4GB（8GB 卡安全线）
4. 冒烟：一条真实提问返回非空；思考模型注意空回复坑
5. 测速（可选）：`timings.predicted_n / predicted_ms`，与下表对照

## 已知陷阱

- 改过后端代码必须重启 uvicorn（前端产物是磁盘实时读取的，Python 不是）——否则版本偏斜
- 手动 taskkill 引擎进程会让产品进程管理器"失忆"，端口仍占用；用产品「停止」按钮停
- GitHub 推送间歇被重置：重试即可
- 评测任务锁：provider 为 local 时锁 `gpu/llama_server`，先启动服务再评测
- **LRFU 有构建门槛**：`E:\kvmem-prism`（v0.16.0-rc3-prism.3）的 `--help` 里没有 `--kvmem-lrfu`，传了直接 `unknown flag` 退出。启动器改成先探 `--help` 再决定发不发，探测不到就报"该二进制不支持 LRFU"而不是让进程静默死掉；配置页的 LRFU 开关也会随之置灰。要真跑 LRFU 只能用内置 v0.18 统一包（ninfer 路线）或升级到 v0.17+ 的 llama-kvmem-server
- **sink/recent 不是额外显存，是从预算里划走**：对齐后之和超过 budget 时，KVMem 与 NInfer 都会在启动阶段拒绝，报的是 usage 而不是清晰错误——配置页已按同一规则实时告警
- **`ninfer-kvmem-server.exe` 名字里带 kvmem 但它是 ninfer 引擎**：从命令文本反推引擎时先判 `ninfer-`，否则会被 `kvmem-server` 抢走判成 GGUF 引擎（`commandImport.ts` 已处理）
- **内置包只带 NInfer 后端**：`engine/` 下的 v0.18 包没有 `llama-kvmem-server.exe`，kvmem 引擎选它当目录会报"未找到引擎二进制"，属预期
