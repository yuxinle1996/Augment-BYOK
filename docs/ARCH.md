# ARCH：Augment-BYOK（新版本架构与最小补丁面）

## 0. 总体架构（Pyramid：3 个支柱）

1) **最小补丁面**：只改 2~3 个注入点，且全部带 marker + fail-fast。  
2) **清晰边界**：把“协议兼容（Augment）”与“上游适配（OpenAI/Anthropic）”拆成稳定模块。  
3) **可回滚**：路由层一键关闭，立即回到原生官方链路。

## 1. 数据流（推荐形态：扩展内路由，不改 completionURL）

```
Augment UI/逻辑
  -> ApiServer.callApi / callApiStream
      -> (注入) byokShim.maybeHandleCallApi(…)
          -> Router (endpoint/model/rule -> byok|official|disabled)
              -> If byok: Provider(OpenAI|Anthropic) + ProtocolConverter
              -> If official: return undefined (走原生官方逻辑)
              -> If disabled: 本地 no-op（不发网络请求）
      -> 原生逻辑（官方）
```

关键点：
- **不全局改 completionURL**：避免把所有端点都“强行收进网关”，降低破坏面。
- 只对“LLM 数据面端点”做拦截；非 LLM 端点默认 official（可用 `routing.rules[endpoint].mode=disabled` 做本地 no-op）。

## 2. 注入/补丁面（必须小且可审计）

### 2.1 必须保留：inject-code.txt

- 注入源：`AugmentBYOK/references/Augment-BYOK-Proxy/vsix-patch/inject-code.txt`
- 新版策略：以 `vendor/augment-interceptor/inject-code.augment-interceptor.v1.2.txt` 作为自包含副本，并在构建期做一致性校验（hash/长度/关键头尾 marker）。
- 风险隔离：网关代码避免依赖 `child_process` / `XMLHttpRequest` 等可能被该注入影响的面，只使用 `fetch` 访问 OpenAI/Anthropic（且 URL 不匹配其拦截规则）。

### 2.2 必须移除：autoAuth

已定位 autoAuth 的来源是构建期补丁：`AugmentBYOK/tools/mol/vsix-patch-set/patch-autoauth-uri.js`  
新版本原则：
- **不引入任何 autoAuth patch**（构建脚本里不允许出现相关步骤）。
- 增加构建期 guard：产物 `out/extension.js` 只要包含 `"/autoAuth"` 或 `handleAutoAuth` 直接失败。

### 2.3 运行时入口（Bootstrap）

在上游 `out/extension.js` 最小插入一行 bootstrap：
- 加载 `./byok/runtime/bootstrap`（新注入文件）
- 注册/初始化 shim（配置加载、热更新、命令、一键回滚开关）

### 2.4 路由注入点（callApi / callApiStream）

在 `callApi`/`callApiStream` 方法体开头注入：
- `const res = await require("./byok/runtime/shim").maybeHandleCallApi*(...)`
- `if (res !== undefined) return res;`

优势：
- 不需要修改官方逻辑的大段代码
- 兼容上游升级：只要方法名/签名基本稳定，patch 成功率高

## 3. 模块划分（运行时）

- `ConfigManager`：读取 extension `globalState` 的配置；保存即热更新；失败保留 last-good。
- `Router`：输入 `(endpoint, requestBody, selectedModel, config)` 输出 `(mode, provider, model)`。
- `ModelRegistry`：`/get-models` 必须注入 `enableModelRegistry/modelRegistry/modelInfoRegistry` 等 feature_flags，否则主面板 Model Picker 入口会被隐藏。
- `AugmentProtocol`：解析 Augment 请求（尤其 `/chat-stream`），输出 canonical request；把 provider stream 转回 Augment NDJSON。
- `ToolPairing`：对齐“工具调用必须配对”的上游硬约束（OpenAI/Anthropic）。在构造 messages 前修复缺失/孤儿 tool_result，避免 400 硬失败。
- `Providers`
  - `OpenAICompatible`：`/chat/completions` streaming（SSE）
  - `Anthropic`：`/messages` streaming（SSE）
- `Errors`：把上游错误映射为 Augment 语义（含 timeout / abort / 429 / 5xx / schema error）。
- `RollbackSwitch`：一键关闭 BYOK（使 Router 恒返回 `official` 或 `undefined`）。

## 4. 一键回滚（定义为“软回滚”）

默认实现：
- 命令：`BYOK: Disable (Rollback)` → 立刻停止 BYOK 路由（不需要卸载 VSIX）
- 命令：`BYOK: Enable` → 恢复 BYOK 路由

可选增强：
- 回滚时同时清除“注入的 BYOK models”（通过停止拦截 `/get-models` 或返回上游原值）
