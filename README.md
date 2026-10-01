# 🦙 llama.cpp Run Manager

可视化管理 llama.cpp server 的模型档案、启动、日志、对话、评测和更新编译。

## 功能

### 模型档案
- 档案 = 模型文件 + mmproj + 启动参数 + 采样 + 提示词，是整个产品的核心对象
- 档案卡片展示 GGUF 头元数据（架构、层数、MoE 专家数、原生上下文长度）
- 一键「启动 / 切换」：加载档案并启动 llama-server，运行中切换会自动重启
- 复制、删除、导入导出，落地页即模型列表

### 推理引擎
- **双引擎**: 本地 llama.cpp 或 KVMem（KV 缓存虚拟化，llama-kvmem-server，引擎目录指向解压根或 bin/）
- **按引擎自适应**: 配置页只显示当前引擎适用的参数；启动命令面板实时探测引擎二进制是否存在
- **思考分层**: 配置页「思考(默认)」按引擎映射 `--reasoning on`（llama.cpp）或 `--enable-thinking`（KVMem）；对话页思考开关对本地模型在显式关闭时发送 `chat_template_kwargs.enable_thinking=false`，开启时遵循服务端默认；DeepSeek 为对称的请求级开关

### 配置管理
- **路径配置**: 引擎目录、模型文件、mmproj 文件（独立文件浏览器，支持盘符切换）
- **聊天模板**: 指定自定义 jinja 模板文件（--chat-template-file），llama.cpp 与 KVMem 通用
- **命令导入**: 粘贴完整 llama-server / llama-kvmem-server 启动命令，自动解析回填所有字段；未识别的参数原样进入「附加参数」
- **命名配置**: 保存/加载/删除多个命名配置（默认 default）
- **导入导出**: JSON 格式配置文件导入导出

### 基础设置
- 上下文长度 (-c)、GPU 卸载层数 (-ngl)、CPU 线程数 (-t)、并行数 (-np)
- MoE CPU 卸载 (--n-cpu-moe)：将专家权重卸载到 CPU，释放显存
- KV 缓存量化 K/V (--cache-type-k/v)：f16, bf16, q8_0, q4_0 等
- 思维链 (--enable-thinking)
- 内存映射 (--mmap)、锁定内存 (--mlock)
- KV 缓存卸载到 GPU (--no-kv-offload)
- Flash Attention (--flash-attn)
- Unified KV 缓存 (--kv-unified)
- GPU 显存余量限制 (--fit-target)
- 逻辑批大小 (-b)、物理批大小 (-ub)
- 上下文自动切换 (--context-shift)
- 缓存 RAM 上限 (--cache-ram)

### MTP 投机解码
- 投机类型 (--spec-type)：draft-mtp
- 最大/最小草稿 token 数 (--spec-draft-n-max/n-min)
- 最小接受概率 (--spec-draft-p-min)：默认 0.75（有损），设为 1.0 可无损
- 分裂概率阈值 (--spec-draft-p-split)

### 采样器
- 温度、Top-K、Top-P（滑块 + 数字输入）
- Min-P（可开关）、重复惩罚（可开关）、存在惩罚（可开关）

### 服务器控制
- 启动/停止 llama-server
- 实时 WebSocket 日志流
- 本地模式 (127.0.0.1) / 局域网模式 (0.0.0.0)

### 对话
- 本地 llama.cpp、DeepSeek、OpenAI Chat/Responses、Anthropic 和 OpenAI 兼容 API
- 原生工具调用 Web Search（Tavily 或 Brave），支持多轮搜索和可见工具轨迹
- 真正的流式输出、停止生成、单轮重生成与回答候选切换
- Markdown、GFM、LaTeX、安全代码块和文件附件导入（支持 PDF，详见「对话附件」）
- 思考分层控制：配置页设服务端默认，对话页开关按请求覆盖
- 会话、消息、候选回答、分支关系和工具轨迹持久化到本地 SQLite

### 评测与实验
- 内置模板与 JSONL/CSV 数据集导入，可把真实任务沉淀为回归样本
- 精确、关键词、正则、JSON Schema 与显式授权命令评分器
- 可选独立 Judge 模型，不会默认复用被测模型
- 对比质量、吞吐、延迟和显存峰值，并展示 Pareto 前沿

### 对话附件
- 文本、Markdown、代码文件直接读取，PDF 由服务端 pypdf 抽取文本
- 单文件上限 30MB / 15 万字符，超出自动截断并提示
- 长上下文引擎（KVMem 工作区 / 256K 原生模型）可直接吃下整份文档

### 全局任务中心
- 评测统一为持久 Job
- GPU、llama-server 和文件系统资源互斥，支持取消、失败重试与检查点
- 应用重启后将未完成任务标记为 interrupted，不接管旧子进程

### 更新管理
- 检测 llama.cpp 更新 (git fetch)
- git pull（支持强制重置）
- cmake 编译（命令可自定义）

### 下载
- 一键克隆 llama.cpp 仓库

## 安装

```bash
cd ~/llama-manager
pip install -r requirements.txt
```

## 启动

**Windows 一键启动（推荐）：**
- 双击 `start.bat` — 显示控制台日志，自动打开浏览器
- 双击 `start-hidden.vbs` — 静默后台启动，自动打开浏览器
- 双击 `stop.bat` — 停止服务

**手动启动：**
```bash
cd ~/llama-manager
python -m uvicorn backend.main:app --host 0.0.0.0 --port 9090
```

然后浏览器打开 `http://localhost:9090`

## API Key 与搜索

Key 不通过网页输入或保存在 provider JSON 中。系统环境变量优先于 `~/llama-manager/.env`：

```dotenv
DEEPSEEK_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
TAVILY_API_KEY=
BRAVE_SEARCH_API_KEY=
```

自定义厂商使用 `LLAMA_MANAGER_PROVIDER_<ID>_API_KEY`，其中 `<ID>` 会转换为大写下划线形式。旧版 `providers.json` 中的 Key 会在启动时迁移到用户 `.env`；只有写入并收紧文件权限成功后才会删除旧字段。

Web Search 只使用设置中明确选择的 Tavily 或 Brave，不抓取搜索结果网页，也不会在失败时自动切换厂商。

## 目录结构

```
llama-manager/
├── backend/
│   ├── main.py               # FastAPI 路由 + WebSocket
│   ├── storage.py            # SQLite WAL + 显式迁移
│   ├── jobs.py               # 持久任务与资源锁
│   ├── evaluation.py         # 数据集评分、Judge、遥测与 Pareto
│   ├── api_models.py         # Pydantic API 契约与附件抽取参数
│   ├── routers/              # 会话、任务和评测路由
│   ├── provider_manager.py   # Provider 元数据与环境 Key
│   ├── search_manager.py     # Tavily / Brave 搜索适配
│   ├── chat_state.py         # 进程内候选上下文图
│   ├── models.py              # Pydantic 数据模型
│   ├── config_manager.py      # 模型档案 CRUD + GGUF 元数据 + 模型扫描
│   ├── process_manager.py     # llama-server 进程管理
│   ├── update_manager.py      # git + cmake 编译
│   ├── download_manager.py    # llama.cpp 仓库克隆
│   └── ...
├── frontend-src/              # React + Vite + TypeScript 源码
├── frontend/                  # 提交到仓库的生产构建产物
├── config/
│   └── *.json                 # 命名配置文件
├── requirements.txt
└── README.md
```

## 使用流程

### 基本使用
1. 填写 llama.cpp 目录路径 → 点击"检测"确认找到 llama-server
2. 选择模型文件（点击"浏览"打开文件浏览器，支持盘符切换）
3. 调整基础设置和采样器参数
4. 切换到"服务器"页 → 点击"启动"
5. 在日志页查看实时输出

### 模型档案
1. 打开「模型」页查看所有已保存的档案卡片（含模型元数据与关键参数）
2. 点击「启动 / 切换」一键加载档案并启动 llama-server，运行中切换会自动重启
3. 「编辑」跳转配置页调整参数后保存，「复制」基于现有档案快速派生新档案
4. 右上角「新建档案」把当前配置保存为新档案

### 配置管理
1. 在配置页输入配置名称
2. 点击"保存配置"保存当前设置
3. 使用下拉框切换已保存的配置
4. 点击"删除"删除非默认配置

## 配置 JSON 格式

配置文件保存在 `~/llama-manager/config/` 目录下，可手动编辑或通过 UI 导入导出。

## 技术栈

- **后端**: Python, FastAPI, WebSocket, aiosqlite, httpx, NumPy
- **前端**: React, Vite, TypeScript, TanStack Query, Motion, CSS Modules
- **进程管理**: asyncio.subprocess

## 前端开发

普通用户不需要 Node.js，`start.bat` 会直接加载已提交的 `frontend/`。修改前端源码时使用 pnpm：

```bash
cd frontend-src
pnpm install
pnpm generate:api
pnpm dev
pnpm test
pnpm build
pnpm test:e2e
```

Vite 开发服务器会代理 `/api` 和 WebSocket；生产构建使用 `/static/` base 并写入仓库根目录的 `frontend/`。
OpenAPI 契约由 `scripts/export_openapi.py` 导出，再用 `openapi-typescript` 生成 `src/generated/api.ts`。
