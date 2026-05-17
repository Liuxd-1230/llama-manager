# 🦙 llama.cpp Run Manager

可视化管理 llama.cpp server 的配置、启动、日志和更新编译。

## 功能

- **配置管理**: 导入 llama.cpp 目录，自动识别模型文件，保存/加载 JSON 配置
- **基础设置**: 上下文长度、GPU 卸载层数、CPU 线程数、并行数、内存映射、MoE CPU 卸载、KV 缓存量化、思维链开关
- **采样器**: 温度、Top-K、Top-P、Min-P（可开关）、重复惩罚（可开关）、存在惩罚（可开关）
- **提示词**: 系统提示词加载、额外参数（实验性 PR 参数）
- **更新管理**: 检测 llama.cpp 更新、git pull、cmake 编译（命令可自定义）
- **运行日志**: 实时 WebSocket 日志流，支持清空和下载
- **服务器模式**: 本地模式 (127.0.0.1) / 局域网模式 (0.0.0.0) 一键切换

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
│   └── update_manager.py      # git + cmake 编译
├── frontend/
│   └── index.html             # 单页 Web UI
├── config/
│   └── default.json           # 默认配置
├── requirements.txt
└── README.md
```

## 配置 JSON 格式

配置文件保存在 `~/llama-manager/config/` 目录下，可手动编辑或通过 UI 导入导出。

## 使用流程

1. 填写 llama.cpp 目录路径 → 点击"检测"确认找到 llama-server
2. 选择模型文件（手动输入路径或点击"浏览"扫描目录）
3. 调整基础设置和采样器参数
4. 切换到"服务器"页 → 点击"启动"
5. 在日志页查看实时输出
