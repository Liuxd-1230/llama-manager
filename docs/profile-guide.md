# 档案创建指南（人机协作）

供 AI 代理与用户协作创建/调整推理档案使用。所有操作走产品 HTTP API（默认 `http://127.0.0.1:9090`），不要直接改 `~/llama-manager/config/*.json`。

## 档案 = 什么

一条档案是一个完整推理配置：引擎 + 引擎目录 + 模型文件 + mmproj + 启动参数（基础/KVMem/MTP）+ 采样 + 聊天模板 + 系统提示词 + 监听地址。

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

## 字段语义（两引擎对照）

| 字段 | llama.cpp | KVMem |
|---|---|---|
| `engine` | `"llama.cpp"`，目录里找 `llama-server.exe` | `"kvmem"`，找 `llama-kvmem-server.exe`（根目录或 bin/） |
| `llama_cpp_dir` | git 检出或解压根 | KVMem 解压根或其 `bin/` |
| 上下文 | `basic.ctx_size`（`-c`，占显存） | `kvmem.workspace`（`-c`，**逻辑工作区，不占显存**） |
| KV 量化 | `basic.kv_cache_quant_k/v`（`-ctk/-ctv`，K/V 分开） | `kvmem.kv_dtype`（`--kv-dtype`，K/V 共用） |
| 思考默认 | `basic.enable_thinking` → `--reasoning on` | `kvmem.enable_thinking` → `--enable-thinking --reasoning-budget` |
| GPU 常驻 | 由 `-c` 决定 | 由 `budget + gen_reserve` 决定，`workspace` 不算 |
| 批次 | `basic.batch_size/ubatch_size` | `kvmem.batch`（**必须 128**，实测 512 减速一半） |

显存账（KVMem，RTX 4060 Laptop 8GB 实测）：**桌面常驻 ~1GB + 权重 5.5GB + CUDA 缓冲 ~0.4GB + (预算+预留) × 25MB/千token（q8_0）或 ~12.5MB/千token（q4_0）**。安全线：总计 ≤ 7.4GB。`basic.ctx_size/threads/parallel/fit/MoE/KV K/V/mmap/...` 在 KVMem 引擎下不进命令，不要设置。

## 实测调优知识（别再重新踩坑）

- KVMem `batch` 必须 128：512 会把解码砍半（29→12 t/s）、prefill 打六折
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
| `bonsai-fast` | KVMem | Heretic PTQ1+MTP Q4头 | 日常主力：workspace 32K / 预算 2K / 预留 4K / KV q4_0 / MTP2，数数 55 t/s、文风 32 t/s |
| `bonsai-mtp` | KVMem | 同上 | 长输出日常：workspace 64K / 预算 8K / 预留 4K / KV q8_0，36-57 t/s 视内容 |
| `kvmem-bonsai` | KVMem | Heretic PTQ1（无 MTP） | 长上下文无 MTP 对照 |
| default | KVMem | 同 bonsai-fast | 历史遗留，可清理 |

PrismML fork（`E:\PrismLlma`，短对话极致 651/27.8 t/s）通过系统直接跑或 WebUI 使用，档案指向它时引擎选 llama.cpp。

## 模型文件合并（Bonsai MTP）

`tools/kvmem/bonsai-mtp-graft-heretic.py`（SHA 白名单含官方与 Heretic PTQ1_0；换新底模先算 SHA256 加白名单）。依赖仅 numpy + 源码树自带 `llama.cpp/gguf-py`，无需 CUDA/PyTorch。产出 `-MTP-r3-Q4_0.gguf`（MTP 头 Q4_0，norm F32，866 张量，851 张逐字节校验）。

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
