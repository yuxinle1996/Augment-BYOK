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

说明：
- 这类存储对用户更友好（无需 env / 文件路径），但 **导出 JSON 会包含敏感 Key/Token**，请谨慎分享。
- 为避免意外把 Key/Token 同步到其它设备，默认只把 `runtimeEnabled` 加入 VS Code Sync（配置请用 Export/Import 迁移）。

## 3) 配置样例（JSON）

见：`Augment-BYOK/config.example.json`

导入方式：打开面板 `BYOK: Open Config Panel` → `Import JSON` → 粘贴 → `Import & Save`。

注意（Official completionUrl）：
- 上游会从 `completionUrl` 的**子域名**提取 `tenantId`（例如 `https://your-tenant.augmentcode.com/` → `your-tenant`）。
- 如果你需要使用官方控制面能力（如 Preferences → Secrets Manager / Remote Agents），请确保 `official.completionUrl` 是你的 tenant URL；否则可能出现 `Not Found`。

## 4) 模型与路由约定

- BYOK 模型 ID 统一格式：`byok:<providerId>:<modelId>`
- `routing.rules[endpoint].mode` 支持：`official` / `byok` / `disabled`（本地 no-op，不发网络请求）。
- 模型选择优先级（无 `model_map`）：
  1) 请求体 `model` 是 `byok:*` → 解析得到 provider+modelId（与 Proxy 语义一致）
  2) 路由规则 `providerId/model` 显式指定 → 强制使用
  3) 否则使用 `routing.defaultProviderId` + `providers[].defaultModel`
- `/get-models` 会把 `providers[].models/defaultModel` 注入为 `byok:*`，让 Augment 的 Model Picker 可直接选择；同时必须返回 `feature_flags.enableModelRegistry/modelRegistry/modelInfoRegistry` 等字段，否则主面板模型选择入口会被隐藏。

## 5) VS Code 命令（运维入口）

- `BYOK: Open Config Panel`：配置面板（Save/Reset/Export/Import/Enable/Disable）。
- `BYOK: Reload Config`：从 `globalState` 重新加载（便于排查同步/异常）。
- `BYOK: Disable (Rollback)`：运行时回滚到官方链路（不改配置）。
