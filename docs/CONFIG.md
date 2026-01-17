# CONFIG：Augment-BYOK 配置（extension globalState）

## 1) 设计原则

- 不使用 VS Code settings（彻底禁用 `augment.advanced.*` 的干预面）。
- 不使用 env / 外部 YAML：配置与 Key/Token 由扩展内部持久化，并可一键导出/导入 JSON。
- 热更新：保存后对后续请求立即生效；错误配置不致命（保留 last-good）。
- 默认策略：`enabled=true`；仅覆盖 13 个 LLM 端点；其它端点默认 official；部分遥测端点默认 disabled（本地 no-op）。

## 2) 配置存储位置

扩展使用 `globalState` 存储：

- 配置：`augment-byok.config.v1`
- 运行时回滚开关：`augment-byok.runtimeEnabled.v1`
- 历史摘要缓存：`augment-byok.historySummaryCache.v1`

说明：
- 这类存储对用户更友好（无需 env / 文件路径），但 **导出 JSON 会包含敏感 Key/Token**，请谨慎分享。
- 为避免意外把 Key/Token 同步到其它设备，默认只把 `runtimeEnabled` 加入 VS Code Sync（配置请用 Export/Import 迁移）。
- `historySummaryCache` 会包含对话摘要文本（可能含代码片段/隐私信息），默认不参与 VS Code Sync；如需清理可使用命令 `BYOK: Clear History Summary Cache`。

## 3) 配置样例（JSON）

见：`Augment-BYOK/config.example.json`

导入方式：打开面板 `BYOK: Open Config Panel` → `Import JSON` → 粘贴 → `Import & Save`。

注意（Official completionUrl）：
- 上游会从 `completionUrl` 的**子域名**提取 `tenantId`（例如 `https://your-tenant.augmentcode.com/` → `your-tenant`）。
- 如果你需要使用官方控制面能力（如 Preferences → Secrets Manager / Remote Agents），请确保 `official.completionUrl` 是你的 tenant URL；否则可能出现 `Not Found`。

## 4) Official 上下文注入（强制开启，无需额外配置）

为尽量贴近 Augment 原生体验，BYOK 在 `/chat` 与 `/chat-stream` 生成前，会尝试复用官方后端的 Context Engine 输出形态，并把结果注入到请求 `nodes`（`REQUEST_NODE_TEXT`）后再交给 BYOK provider 生成。

注入链路包含三部分：
- **Codebase retrieval**：调用官方 `agents/codebase-retrieval` 获取 `formatted_retrieval` 并注入。
- **External sources**：若请求未禁用外部来源，会调用 `get-implicit-external-sources` 推断可用 source IDs，并用 `search-external-sources` 拉取可展示的外部来源摘要后注入。
- **Context Canvas（canvasId）**：若请求包含 `canvas_id`/`canvasId`，会调用 `context-canvas/list` 尝试解析 canvas 的 `name/description` 并注入（用于尽量还原“选了某个 canvas”时的上下文提示）。

行为约定：
- **无需额外开关**：只要能拿到 Official `completionUrl` + `apiToken` 就自动启用；不可用时会自动跳过，不影响 BYOK 生成。
- **按请求可禁用**：请求体里设置 `disableRetrieval=true`（或 `disable_retrieval=true`）会跳过上述所有注入。
- **内置超时/长度**：默认 `max_output_length=20000`，检索注入超时上限约 `12000ms`（并受上游请求 timeout 的 50% 限制）。

## 5) 模型与路由约定

- BYOK 模型 ID 统一格式：`byok:<providerId>:<modelId>`
- `routing.rules[endpoint].mode` 支持：`official` / `byok` / `disabled`（本地 no-op，不发网络请求）。
- 模型选择优先级（无 `model_map`）：
  1) 请求体 `model` 是 `byok:*` → 解析得到 provider+modelId（与 Proxy 语义一致）
  2) 路由规则 `providerId/model` 显式指定 → 强制使用
  3) 否则使用 `routing.defaultProviderId` + `providers[].defaultModel`
- `/get-models` 会把 `providers[].models/defaultModel` 注入为 `byok:*`，让 Augment 的 Model Picker 可直接选择；同时必须返回 `feature_flags.enableModelRegistry/modelRegistry/modelInfoRegistry` 等字段，否则主面板模型选择入口会被隐藏。

### 5.1 providers[].type（支持的上游协议）

- `openai_compatible`：OpenAI Chat Completions（`POST /chat/completions`）及兼容网关
- `openai_responses`：OpenAI Responses（`POST /responses`，Codex/新式 Responses 流式事件）
  - 可在 `providers[].requestDefaults` 里配置 `reasoning.effort`（例如：`"low" | "medium" | "high"`）
- `anthropic`：Anthropic Messages（`POST /messages`）
- `gemini_ai_studio`：Google Gemini（AI Studio API Key / Generative Language API `v1beta`）
  - `baseUrl` 推荐：`https://generativelanguage.googleapis.com/v1beta`
  - `model` 推荐用完整名：`models/gemini-1.5-flash`（本实现也接受 `gemini-1.5-flash` 并自动补前缀）

## 6) VS Code 命令（运维入口）

- `BYOK: Open Config Panel`：配置面板（Save/Reset/Export/Import/Enable/Disable）。
- `BYOK: Reload Config`：从 `globalState` 重新加载（便于排查同步/异常）。
- `BYOK: Disable (Rollback)`：运行时回滚到官方链路（不改配置）。
- `BYOK: Clear History Summary Cache`：清空历史摘要缓存（不会影响面板显示的完整历史；仅影响后台滚动摘要复用）。

## 7) 工具调用（严格对接 Augment 协议）

### 7.1 Augment 侧（本扩展输入/输出的“单一真相”）

- **工具请求（tool use）**：来自模型输出的 `response_nodes`：
  - `RESPONSE_NODE_TOOL_USE_START`（可选，仅用于 UI/调度提示）
  - `RESPONSE_NODE_TOOL_USE`（实际工具调用，包含 `tool_use_id/tool_name/input_json`）
- **工具结果（tool result）**：由客户端/Agent 执行工具后，在下一次请求里回填到 `request_nodes`：
  - `REQUEST_NODE_TOOL_RESULT`（包含 `tool_use_id` + `content`/`content_nodes` + `is_error`）

这意味着：**任何一次模型发出的 tool_use，都必须在后续请求中出现同一个 `tool_use_id` 的 tool_result**，否则对话会停在“等待工具结果”的中间状态。

### 7.2 上游 Provider 的硬约束（否则会 400/422）

- **OpenAI Chat Completions（`openai_compatible`）**
  - `messages` 中一旦出现 `role:"assistant"` + `tool_calls:[{id:"call_x",...}]`
  - 后续必须出现 `role:"tool"` + `tool_call_id:"call_x"` 的工具结果消息（每个 id 都要回）
- **OpenAI Responses（`openai_responses`）**
  - `input` 中一旦出现 `type:"function_call"` + `call_id:"call_x"`
  - 后续必须出现 `type:"function_call_output"` + `call_id:"call_x"`（每个 call_id 都要回）
- **Anthropic**
  - assistant `content` 中出现 `tool_use`（`id`）
  - 后续必须出现 user `content` 中的 `tool_result`（`tool_use_id` 匹配）
- **Gemini（AI Studio / `gemini_ai_studio`）**
  - model `parts` 中出现 `functionCall`（`name`）
  - 后续必须出现 user `parts` 中的 `functionResponse`（同名 `name` 对应）

### 7.3 BYOK 的容错策略（避免“硬失败”）

为避免因工具执行失败/网络错误/历史裁剪导致的“缺 tool_result → 上游直接 400/422”，BYOK 在构造上下文时会做一次配对修复（按 provider 协议分别处理）：

- 缺失 `tool_result`：自动注入一个“错误型 tool_result”（内容为 JSON，标记 `tool_result_missing`），让模型能继续对话并自行降级。
- 出现孤儿 `tool_result`（历史里找不到对应 tool_call）：转换成 `role:"user"` 的纯文本提示，避免 OpenAI 拒绝请求。

这不是“隐藏错误”，而是把“协议级 hard error”降级成“模型可见的软错误”，便于继续工作与排查。

### 7.4 Provider 鉴权补充（多运营商兼容）

`providers[].apiKey` 现在允许为空：只要你在 `providers[].headers` 里提供了有效鉴权头（例如 `authorization`/`api-key`/`x-api-key`/`x-goog-api-key` 等）。  
如果 `apiKey` 与 `headers` 都为空，请求会在本地 fail-fast。
