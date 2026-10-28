# Atelier

Atelier 是面向 Windows 的本地创作与模型工作台。模型下载、推理配置、对话、提示词、构图与 ComfyUI 出图在同一处衔接。

根目录 `DESIGN.md` 是项目 UI/UX 准则；本次视觉选择见 `docs/atelier-design.md`。

## 工作区

- **工作台**：接续创作项目、查看作品与持久化任务。
- **创作**：项目 → 系列 → 分页，切换成稿、构图和出图；支持分段、固定文字、逐段采纳改稿、对照翻译、撤销与版本记录。
- **模型**：管理 llama.cpp、KVMem 与 NInfer 档案；配置模型、MMProj、采样和服务参数，查看运行与日志。
- **下载**：解析 Hugging Face / 镜像链接，筛选文件，使用指定目录或 HF 缓存下载；支持暂停、续传、重试、并发、历史和 Token。
- **素材**：离线标签与角色词库、自定义角色、画师、LoRA、作品、记事本、Preset 与 MCP。
- **对话**：保留流式输出、附件、搜索、候选回答与历史。
- **设置**：共享模型连接、外观、创作偏好和引擎维护。

## 启动

需要 Windows 10/11、Python 3.11+。正常使用不需要 Node.js。

```powershell
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 9090
```

也可双击 `start.bat`，浏览器访问 http://localhost:9090 。

## 从提示词到出图

1. 在设置中配置已有模型服务，或在模型页启动本地档案。密钥可以通过环境变量提供，或用 Windows DPAPI 加密保存。
2. 创建项目，写成稿或安排构图。MOSS、Anima 与普通文本是独立的编译目标；Anima 的语义解析需要可用的文本模型。
3. 在素材库保存并引用角色、画师和 LoRA。同系列新页继承素材引用；Preset 可提供系统提示与采样参数。
4. 出图视图连接**已运行的 ComfyUI**，导入 API 格式工作流并绑定提示词和参数。Anima 预设会填入可编辑 JSON，请核对本机模型文件名、节点及采样器后导入。
5. 引用 LoRA 时，选择工作流中对应的 `LoraLoader` 节点；权重和触发词与提示词、提交参数联动。
6. 每次生成保留文档与工作流快照。结果可下载、收藏、比较或返回原稿再编辑。

Atelier 不安装、启动或停止外部 ComfyUI。显存冲突时先提示；只有确认后才暂停 Atelier 受管的本地引擎，之后由用户决定何时恢复。正在执行的外部 ComfyUI 中断需到 ComfyUI 操作，以免影响别的任务。

图片反推支持已配置的视觉 API 与本地视觉 GGUF。为本地档案添加模型和 MMProj 后，可在反推窗口选择并加载。未加入 Florence、ONNX 打标、独立机器翻译链或多语言界面。

### Agent 如何修改原稿

Agent 通过 `update_summary`、`add_items`、`update_items` 等工具修改文档，再生成可采纳的改动提案。采纳后才保存并更新画布；开启自动采纳时仍经过版本和锁定检查。优先使用模型原生工具调用，不支持时可退回约定的结构化标签协议。

没有实际改动或成功工具记录，却声称已修改的回复会触发执行核验、一次重试及失败提示。普通回复中的“执行成功”文字不会直接变成文档操作。修改构图或描述不会改变已经生成的图片，需要重新出图。

### 自定义聊天模板

llama.cpp / KVMem 档案可在配置页选择 `.jinja` 等聊天模板文件，保存档案后通过 `--chat-template-file` 使用；重新启动模型后生效。目前保存的是文件路径，没有内置的模板正文编辑、读取或一键复制功能。请先将模板内容保存为本地文件，再选择它。

## 数据与迁移

- 默认目录：`%LOCALAPPDATA%\Atelier`；可设置 `ATELIER_DATA_DIR` 使用其他目录。
- 首次启动从 `~/llama-manager` 备份迁移，聊天和工坊数据合并进入 `atelier.db`；旧目录不删除。备份路径记录在新目录的 `migration.json`。
- 自动识别相邻 HF Mirror Downloader 项目或其 LocalAppData 目录的历史与 Token，导入前保留数据库备份。
- 模型文件和 HF 缓存保持原路径。迁移失败会停止切换，原始数据与备份保留。
- 密钥不通过列表 API 返回。环境变量优先于应用加密存储；现有 `.env` 配置继续支持。
- 下载可手动恢复断点；服务重启后，其他未完成任务标记为已中断，不自动重放生成或工具调用。

切换数据目录或重启排查前，请保留当前数据的独立备份并核对实际使用的目录。浏览器仍显示的内容不等于已有完整备份；只恢复当前原稿或已加载消息，也不代表全部历史版本和任务记录已恢复。

配置、调优档案前请先阅读 `docs/profile-guide.md`。

## 开发与验证

前端源码在 `frontend-src`，生产文件提交在 `frontend`；后端入口只负责生命周期与路由，领域服务位于 `backend/routers`、`backend/atelier` 和现有引擎模块。

```powershell
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.venv\Scripts\python.exe -m unittest discover -s tests
.venv\Scripts\python.exe -m pytest tests/hf_download -q
cd frontend-src
npm run generate:api
npx vitest run
npx tsc -b
npm run build
npx playwright test
```

API 使用 `/api/v1`，文档在 `/docs`。下载、Agent 和生成任务持久化，任务事件使用 SSE；引擎日志使用 WebSocket。浏览器测试默认连接 `http://127.0.0.1:9092`；可用 `E2E_BASE_URL` 覆盖，务必为验收后端设置独立的 `ATELIER_DATA_DIR`。

业务状态与模块职责见 [业务约定](docs/atelier-architecture.md)，真实联调、自动回归和验证边界见 [验证记录](docs/atelier-validation.md)。品牌与微动效的具体选择见 [设计参考卡](docs/atelier-design.md)；根目录 `DESIGN.md` 保留为最高项目设计准则。

本轮交付范围、验证结果与已知限制见 [更新记录](docs/atelier-release-notes.md)。截图、录像、测试输出和本机数据备份保留在本地，不随源码提交。

## 来源

本项目提取并适配 HF Mirror Downloader、[ImageForge](https://github.com/Liuxd-1230/ImageForge)、[Penna](https://github.com/storyAura/Penna)，并保留已有 MOSS Prompt Studio 集成。来源、原始许可与数据署名见 `THIRD_PARTY_NOTICES.md` 和 `licenses/`。
