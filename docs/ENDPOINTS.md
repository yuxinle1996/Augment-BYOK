# ENDPOINTS：上游端点清单与功能映射（基于 upstream-analysis.json）

结论：上游 `augment/vscode-augment`（版本见 `Augment-BYOK/upstream.lock.json`）在扩展侧共引用 **71 个端点**，其中“可由 LLM 直接替代的数据面端点”是 **13 个**（其余多为控制面/遥测/集成能力，不能用纯 LLM 取代）。

数据来源：
- `Augment-BYOK/.cache/reports/upstream-analysis.json`（端点全集）
- `Augment-BYOK/dist/endpoint-coverage.report.md`（LLM 端点=13 的统计与 call kind / 输入输出形状）

## 1) LLM 数据面（BYOK 需要全部覆盖）

### callApi（非流，6）
- `/get-models`：拉取可用模型/feature flags（并可注入 BYOK models registry）。
- `/chat`：非流式 chat（或某些场景的 chat 请求）。
- `/completion`：编辑器 inline completion（短文本）。
- `/chat-input-completion`：Chat 输入框智能补全。
- `/edit`：代码编辑/改写（输出文本或结构化编辑结果）。
- `/next_edit_loc`：Next Edit 定位（候选位置 JSON，模型输出必须可解析）。

### callApiStream（流式，7）
- `/chat-stream`：核心聊天流（Augment NDJSON）。
- `/prompt-enhancer`：提示词增强（stream）。
- `/instruction-stream`：指令生成/改写（stream）。
- `/smart-paste-stream`：Smart Paste（stream）。
- `/next-edit-stream`：Next Edit 建议（stream）。
- `/generate-commit-message-stream`：Commit message（stream）。
- `/generate-conversation-title`：会话标题（stream）。

## 2) Remote Agents（控制面/编排，不属于“纯 LLM 可替代”）

说明：这些端点背后依赖“远程执行环境/状态机/权限/日志”，单 VSIX 的 BYOK 不应尝试复刻；建议默认 **official**（或按需 disabled）。

- `/remote-agents/create`：创建远程 agent。
- `/remote-agents/update`：更新配置。
- `/remote-agents/delete`：删除。
- `/remote-agents/list`：列表（一次性）。
- `/remote-agents/list-stream`：列表（流式更新）。
- `/remote-agents/chat`：与远程 agent 对话/下达任务。
- `/remote-agents/get-chat-history`：拉取对话历史（一次性）。
- `/remote-agents/agent-history-stream`：对话/事件历史流。
- `/remote-agents/logs`：日志。
- `/remote-agents/interrupt`：中断执行。
- `/remote-agents/pause`：暂停。
- `/remote-agents/resume`：恢复。
- `/remote-agents/resume-hint`：恢复提示/状态同步。
- `/remote-agents/generate-summary`：生成摘要（可能用到 LLM，但仍是控制面的一部分）。
- `/remote-agents/add-ssh-key`：写入 SSH key（权限敏感）。

## 3) Agents / Tools（工具权限与远程工具调用，不属于“纯 LLM 可替代”）

- `/agents/check-tool-safety`：工具安全性检查/准入。
- `/agents/revoke-tool-access`：撤销工具权限。
- `/agents/list-remote-tools`：列出可用远程工具。
- `/agents/run-remote-tool`：执行远程工具。
- `/agents/edit-file`：通过 agent 执行文件编辑（通常伴随工具调用与权限）。
- `/agents/codebase-retrieval`：代码库检索（偏检索/服务能力，不是 LLM completion）。

## 4) 文件/Blob/上下文同步（基础设施能力）

- `/batch-upload`：批量上传 blobs（文件内容/上下文）。
- `/checkpoint-blobs`：checkpoint 相关 blobs 操作（取/存/校验）。
- `/find-missing`：查找缺失 blob（补齐上下文用）。
- `/save-chat`：保存会话/记录（服务端持久化）。
- `/context-canvas/list`：Context Canvas 列表（上下文面板/结构化引用）。
- `/get-implicit-external-sources`：隐式外部来源（可能用于 RAG/引用）。
- `/search-external-sources`：外部来源搜索。

## 5) GitHub 集成

- `/github/is-user-configured`：是否已配置 GitHub。
- `/github/list-repos`：仓库列表。
- `/github/list-branches`：分支列表。
- `/github/get-repo`：获取指定 repo 信息/元数据。

## 6) 账号/订阅/权限/Secrets

- `/token`：token 获取/刷新（鉴权相关）。
- `/get-credit-info`：额度/credits 信息。
- `/subscription-banner`：订阅提示 banner。
- `/settings/get-tenant-tool-permissions`：tenant 级工具权限配置。
- `/user-secrets/list`：列出用户 secrets。
- `/user-secrets/upsert`：写入/更新 secrets。
- `/user-secrets/delete`：删除 secrets。

## 7) 反馈/遥测/调试（非 LLM，通常可保持 official 或按需禁用）

建议默认 disabled（本地 no-op）：`/client-*`、`/record-*`、`/report-*`、`/resolve-*`（见默认配置 `routing.rules` 中对应 endpoint 的 `mode=disabled`，可在 `BYOK: Open Config Panel` 调整）。

显式反馈：
- `/chat-feedback`：聊天反馈。
- `/completion-feedback`：补全反馈。
- `/next-edit-feedback`：Next Edit 反馈。

遥测/事件：
- `/client-metrics`：客户端指标。
- `/client-completion-timelines`：completion timeline（行为序列）。
- `/record-session-events`：会话事件。
- `/record-user-events`：用户事件。
- `/record-preference-sample`：偏好样本（用于训练/评估）。
- `/record-request-events`：请求事件记录（与注入拦截器的 debug 能力相关）。

错误与特征：
- `/report-error`：错误上报。
- `/report-feature-vector`：特征向量上报（模型/推荐系统相关）。

“resolve*”类（从上游调用样本看更像日志/归因，而非生成）：
- `/resolve-completions`
- `/resolve-chat-input-completion`
- `/resolve-edit`
- `/resolve-instruction`
- `/resolve-next-edit`
- `/resolve-smart-paste`

## 8) 通知

- `/notifications/read`：拉取通知。
- `/notifications/mark-as-read`：标记已读。
