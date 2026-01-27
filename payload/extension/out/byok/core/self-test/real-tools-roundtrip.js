"use strict";

const { normalizeString, randomId } = require("../../infra/util");
const shared = require("../augment-chat/shared");
const { sampleJsonFromSchema } = require("./schema-sample");
const { dedupeToolDefsByName } = require("./tool-defs");
const { pickRealToolsForUsabilityProbe } = require("./tools-schema");
const { providerLabel } = require("./util");
const { makeBaseAugmentChatRequest, makeToolResultNode } = require("./builders");
const { extractToolUsesFromNodes } = require("./stream");
const { chatStreamByProvider } = require("./provider-io");

async function realToolsToolRoundtripByProvider({ provider, model, toolDefinitions, timeoutMs, abortSignal, maxTools, log }) {
  const providerType = normalizeString(provider?.type);
  const toolDefsAll = Array.isArray(toolDefinitions) ? toolDefinitions : [];
  const uniqueDefs = dedupeToolDefsByName(toolDefsAll);
  const uniqueCount = uniqueDefs.length;
  if (!uniqueCount) return { ok: false, detail: "no tools" };

  const desired = Number.isFinite(Number(maxTools)) && Number(maxTools) > 0 ? Math.floor(Number(maxTools)) : uniqueCount;
  const pickedToolDefs = pickRealToolsForUsabilityProbe(toolDefsAll, { maxTools: Math.max(1, Math.min(desired, uniqueCount)) });
  const toolNames = pickedToolDefs.map((d) => normalizeString(d?.name)).filter(Boolean);
  if (!toolNames.length) return { ok: false, detail: "no toolNames" };

  const toolDefsByName = new Map(pickedToolDefs.map((d) => [normalizeString(d?.name), d]).filter((x) => x[0]));

  const metaMismatches = [];
  const callErrors = [];
  const callSkipped = [];
  const roundtripFailed = [];
  let calledOk = 0;
  let roundtripOk = 0;

  const emit = (line) => {
    try {
      if (typeof log === "function") log(String(line || ""));
    } catch {}
  };

  const buildExampleArgsJson = (toolDef) => {
    const rawSchema = shared.resolveToolSchema(toolDef);
    const schema = providerType === "openai_responses" ? shared.coerceOpenAiStrictJsonSchema(rawSchema, 0) : rawSchema;
    const sample = sampleJsonFromSchema(schema, 0);
    if (sample && typeof sample === "object" && !Array.isArray(sample)) {
      // 少量启发式：减少上游/网关对 format/pattern 的额外校验风险
      if (typeof sample.url === "string") sample.url = "https://example.com";
      if (typeof sample.uri === "string") sample.uri = "https://example.com";
      if (typeof sample.query === "string") sample.query = "hello";
      if (typeof sample.text === "string") sample.text = "hello";
      if (typeof sample.path === "string") sample.path = "selftest.txt";
    }
    try {
      return JSON.stringify(sample ?? {});
    } catch {
      return "{}";
    }
  };

  // 目标：覆盖所有真实工具，但减少请求量/配额压力。
  // 方案：按 batch 要求模型在同一条 assistant 消息里一次性调用多个工具，然后回填多个 tool_result。
  const batchSize = 6;
  const batches = [];
  for (let i = 0; i < toolNames.length; i += batchSize) batches.push(toolNames.slice(i, i + batchSize));

  for (let bi = 0; bi < batches.length; bi++) {
    const namesBatch = batches[bi];
    const defsBatch = namesBatch.map((n) => toolDefsByName.get(n)).filter(Boolean);
    if (!defsBatch.length) continue;

    const argsLines = [];
    for (const toolName of namesBatch) {
      const toolDef = toolDefsByName.get(toolName) || null;
      if (!toolDef) continue;
      argsLines.push(`- ${toolName}: ${buildExampleArgsJson(toolDef)}`);
    }

    const convId = `byok-selftest-realtools-batch-${randomId()}`;
    const req1 = makeBaseAugmentChatRequest({
      message:
        `Self-test (real tools) batch ${bi + 1}/${batches.length}.\n` +
        `You MUST call ALL tools below in THIS assistant message.\n` +
        `- Do NOT output normal text; only call tools.\n` +
        `- Call each tool exactly once.\n` +
        `- Use EXACT JSON arguments:\n` +
        argsLines.join("\n") +
        `\n`,
      conversationId: convId,
      toolDefinitions: defsBatch,
      nodes: [],
      chatHistory: []
    });

    let res1;
    try {
      res1 = await chatStreamByProvider({ provider, model, req: req1, timeoutMs, abortSignal });
    } catch (err) {
      if (abortSignal && abortSignal.aborted) throw err;
      for (const name of namesBatch) callErrors.push(name);
      emit(`[${providerLabel(provider)}] realTools batch ${bi + 1}/${batches.length}: FAIL (chat-stream error: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }

    const toolUses = extractToolUsesFromNodes(res1?.nodes);
    const usedByName = new Map(); // tool_name -> tool_use
    for (const t of toolUses) {
      const n = normalizeString(t?.tool_name);
      if (!n || usedByName.has(n)) continue;
      if (!namesBatch.includes(n)) continue;
      usedByName.set(n, t);
    }

    for (const toolName of namesBatch) {
      const toolDef = toolDefsByName.get(toolName) || null;
      const match = usedByName.get(toolName) || null;
      if (!match) {
        const sr = normalizeString(res1?.stop_reason) || "n/a";
        callSkipped.push(toolName);
        emit(`[${providerLabel(provider)}] realTools batch ${bi + 1}/${batches.length}: WARN tool=${toolName} (no tool_use, stop_reason=${sr})`);
        continue;
      }

      calledOk += 1;

      const expectedMcpServerName = normalizeString(toolDef?.mcp_server_name ?? toolDef?.mcpServerName);
      const expectedMcpToolName = normalizeString(toolDef?.mcp_tool_name ?? toolDef?.mcpToolName);
      if (expectedMcpServerName && normalizeString(match.mcp_server_name) !== expectedMcpServerName) {
        metaMismatches.push(`mcp_server_name ${toolName}: expected=${expectedMcpServerName} got=${normalizeString(match.mcp_server_name) || "?"}`);
      }
      if (expectedMcpToolName && normalizeString(match.mcp_tool_name) !== expectedMcpToolName) {
        metaMismatches.push(`mcp_tool_name ${toolName}: expected=${expectedMcpToolName} got=${normalizeString(match.mcp_tool_name) || "?"}`);
      }
    }

    // 没有任何 tool_use 时，不做 roundtrip（callFailed 已覆盖）
    if (usedByName.size === 0) continue;

    const exchange1 = {
      request_id: `selftest_realtools_batch_${bi + 1}_1`,
      request_message: req1.message,
      response_text: "",
      request_nodes: [],
      structured_request_nodes: [],
      nodes: [],
      response_nodes: Array.isArray(res1?.nodes) ? res1.nodes : [],
      structured_output_nodes: []
    };

    const req2 = makeBaseAugmentChatRequest({
      message: `Self-test (real tools) batch ${bi + 1}/${batches.length}: Tool results received. Reply with OK-realtools-batch. Do NOT call any tool.`,
      conversationId: convId,
      toolDefinitions: defsBatch,
      nodes: [],
      chatHistory: [exchange1]
    });

    let toolResultNodeId = 1;
    req2.request_nodes = Array.from(usedByName.entries()).map(([toolName, match]) =>
      makeToolResultNode({
        id: toolResultNodeId++,
        toolUseId: match.tool_use_id,
        contentText: JSON.stringify({ ok: true, tool: toolName }),
        isError: false
      })
    );

    let res2;
    try {
      res2 = await chatStreamByProvider({ provider, model, req: req2, timeoutMs, abortSignal });
    } catch (err) {
      if (abortSignal && abortSignal.aborted) throw err;
      for (const toolName of usedByName.keys()) roundtripFailed.push(toolName);
      emit(`[${providerLabel(provider)}] realTools batch ${bi + 1}/${batches.length}: FAIL (toolRoundtrip error: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }

    const text2 = normalizeString(res2?.text);
    if (!text2) {
      const sr = normalizeString(res2?.stop_reason) || "n/a";
      for (const toolName of usedByName.keys()) roundtripFailed.push(toolName);
      emit(`[${providerLabel(provider)}] realTools batch ${bi + 1}/${batches.length}: FAIL (empty assistant text after tool_result, stop_reason=${sr})`);
      continue;
    }

    for (const toolName of usedByName.keys()) roundtripOk += 1;

    emit(`[${providerLabel(provider)}] realTools progress: batch ${bi + 1}/${batches.length} called=${usedByName.size}/${namesBatch.length}`);
  }

  const detailParts = [`tools=${toolNames.length}/${uniqueCount}`, `call=${calledOk}/${toolNames.length}`, `roundtrip=${roundtripOk}/${toolNames.length}`];
  if (callSkipped.length) detailParts.push(`call_skipped=${callSkipped.length} first=${callSkipped[0]}`);
  if (callErrors.length) detailParts.push(`call_error=${callErrors.length} first=${callErrors[0]}`);
  if (roundtripFailed.length) detailParts.push(`roundtrip_fail=${roundtripFailed.length} first=${roundtripFailed[0]}`);
  if (metaMismatches.length) detailParts.push(`meta_mismatch=${metaMismatches.length} first=${metaMismatches[0]}`);

  // 说明：真实工具集里可能包含“高风险/受限”工具名，部分模型会选择跳过（不产出 tool_use）。
  // 这类“未调用”不应被视为 BYOK 工具链路故障；只要 chat-stream 可用、tool_result 往返无误、且 meta 不冲突即可。
  // 若本次完全未触发 tool_use，视为“未覆盖到”（detail 会显示 call=0/... + call_skipped=...），不作为失败。
  const ok = callErrors.length === 0 && roundtripFailed.length === 0 && metaMismatches.length === 0;
  return { ok, detail: detailParts.join(" ").trim() };
}

module.exports = { realToolsToolRoundtripByProvider };
