# 🦙 llama.cpp Run Manager

可视化管理 llama.cpp server 的配置、启动、日志、更新编译和贝叶斯自动优化。

## 功能

### 配置管理
- **路径配置**: llama.cpp 目录、模型文件、mmproj 文件（独立文件浏览器，支持盘符切换）
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

### 自动优化 (Optuna 贝叶斯优化)
- 搜索最优参数组合：ngl × n_cpu_moe × 上下文深度 × KV 缓存量化
- 使用 llama-bench `-d` (n-depth) 测试不同上下文深度
- 实时 WebSocket 日志流 + 结果表格
- 自动识别 OOM/错误，失败试验跳过
- 动态超时（根据上下文大小调整）
- 一键应用最优结果到配置

### 服务器控制
- 启动/停止 llama-server
- 实时 WebSocket 日志流
- 本地模式 (127.0.0.1) / 局域网模式 (0.0.0.0)

### 对话
- OpenAI 兼容 API 代理 (/v1/chat/completions)
- 流式输出 + 对话历史

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

## 目录结构

```
llama-manager/
├── backend/
│   ├── main.py               # FastAPI 路由 + WebSocket
│   ├── models.py              # Pydantic 数据模型
│   ├── config_manager.py      # 配置 CRUD + 模型扫描
│   ├── process_manager.py     # llama-server 进程管理
│   ├── update_manager.py      # git + cmake 编译
│   ├── download_manager.py    # llama.cpp 仓库克隆
│   └── optimizer.py           # Optuna 贝叶斯优化
├── frontend/
│   ├── index.html             # HTML 结构
│   ├── style.css              # 样式
│   └── app.js                 # 前端逻辑
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

### 自动优化
1. 切换到"自动优化"页
2. 设置 ngl/n_cpu_moe 范围、上下文深度、KV 缓存量化选项
3. 点击"开始优化"
4. 等待 Optuna 搜索最优参数组合
5. 点击"应用"将最优结果应用到配置

### 配置管理
1. 在配置页输入配置名称
2. 点击"保存配置"保存当前设置
3. 使用下拉框切换已保存的配置
4. 点击"删除"删除非默认配置

## 配置 JSON 格式

配置文件保存在 `~/llama-manager/config/` 目录下，可手动编辑或通过 UI 导入导出。

## 技术栈

- **后端**: Python, FastAPI, WebSocket
- **前端**: HTML, CSS, JavaScript (原生)
- **优化**: Optuna (贝叶斯优化)
- **进程管理**: asyncio.subprocess
