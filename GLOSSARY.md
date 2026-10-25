# GLOSSARY

llama-manager 的领域与架构词汇表。架构术语遵循 /codebase-design 词汇：module、interface、depth、seam、adapter、leverage、locality。

## 聊天 / Chat

- **Chat Adapters（聊天适配层）** — `backend/chat_adapters.py`。把各种 provider 协议的聊天知识（payload 构建、tool loop、流式归一化、分支上下文形态）收敛在一个 deep module 后面；对外 interface 为 `build_chat_request` / `stream_chat_completion` / `complete_chat_completion`。
- **Provider Kind（协议族）** — 聊天 provider 的协议分类：`openai_chat`（涵盖 llama.cpp / KVMem 本地引擎、deepseek、openai_compatible）、`anthropic`、`openai_responses`。决定端点 URL、payload 形状、tool loop 实现与 Branch Context 的形态。
- **Tool Loop（工具循环）** — web_search 工具的多轮循环：模型发起调用 → 适配层执行 → 结果回填 → 续答；含 DSML 伪调用兜底、强制搜索重试（仅非流式）与轮数上限。
- **DSML** — 部分模型在 reasoning 里输出的伪工具调用标记（`<|DSML|tool_calls|>`）。适配层将其解析为真实 web_search 调用，并从对外展示文本中剥离。
- **Branch Context（分支上下文）** — 候选续聊所依赖的服务端状态，形态由 Provider Kind 决定：`chat_messages`（openai 系消息数组）、`anthropic_messages`、`responses`（previous_response_id）。
- **Candidate Context（候选上下文）** — ConversationStore 中按 (conversation_id, candidate_id) 存储的一条 Branch Context，含 provider_id 与 model，用于分支续聊与一致性校验。
- **V2 Event Stream（v2 事件流）** — 聊天流式的 v2 事件协议（start / content_delta / reasoning_delta / tool_call / tool_result / tool_status / timings / usage / error / done），由适配层从 provider 原生 SSE 归一化而来。

## 引擎 / Engines

- **Engine（推理引擎）** — 受管推理进程的协议分类：`llama.cpp`（llama-server）、`kvmem`（llama-kvmem-server）、`ninfer`（ninfer-kvmem-server）。与 Provider Kind 无关：引擎决定启动命令与设置面板，Provider Kind 决定聊天协议。
