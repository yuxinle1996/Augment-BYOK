"use strict";

const { normalizeString } = require("../infra/util");
const { normalizeUsageInt, makeToolMetaGetter } = require("./provider-util");
const { extractErrorMessageFromJson } = require("./request-util");
const { rawResponseNode, thinkingNode, makeBackChatChunk, mapOpenAiFinishReasonToAugment } = require("../core/augment-protocol");
const { buildToolUseChunks, buildTokenUsageChunk, buildFinalChatChunk } = require("./chat-chunks-util");

function extractTextFromChatCompletionJson(json) {
  const obj = json && typeof json === "object" ? json : null;
  if (!obj) return "";
  const choice0 = Array.isArray(obj.choices) ? obj.choices[0] : null;
  const c0 = choice0 && typeof choice0 === "object" ? choice0 : null;
  const msg = c0 && typeof c0.message === "object" ? c0.message : null;
  const direct = typeof msg?.content === "string" ? msg.content : typeof c0?.text === "string" ? c0.text : "";
  return normalizeString(direct);
}

function extractToolCallsFromChatCompletionJson(json) {
  const obj = json && typeof json === "object" ? json : null;
  if (!obj) return [];
  const choice0 = Array.isArray(obj.choices) ? obj.choices[0] : null;
  const c0 = choice0 && typeof choice0 === "object" ? choice0 : null;
  const msg = c0 && typeof c0.message === "object" ? c0.message : null;

  const out = [];
  const tcs = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
  for (const tc of tcs) {
    if (!tc || typeof tc !== "object") continue;
    const id = normalizeString(tc.id);
    const fn = tc.function && typeof tc.function === "object" ? tc.function : null;
    const name = normalizeString(fn?.name);
    const args = typeof fn?.arguments === "string" ? fn.arguments : "";
    if (!name) continue;
    out.push({ id, name, args });
  }

  const fc = msg?.function_call && typeof msg.function_call === "object" ? msg.function_call : null;
  if (fc) {
    const name = normalizeString(fc.name);
    const args = typeof fc.arguments === "string" ? fc.arguments : "";
    if (name) out.push({ id: "", name, args });
  }

  return out;
}

function extractStopReasonFromChatCompletionJson(json) {
  const obj = json && typeof json === "object" ? json : null;
  if (!obj) return { stopReason: null, stopReasonSeen: false };
  const choice0 = Array.isArray(obj.choices) ? obj.choices[0] : null;
  const fr = normalizeString(choice0?.finish_reason);
  if (!fr) return { stopReason: null, stopReasonSeen: false };
  return { stopReason: mapOpenAiFinishReasonToAugment(fr), stopReasonSeen: true };
}

function extractUsageFromChatCompletionJson(json) {
  const obj = json && typeof json === "object" ? json : null;
  const u = obj && typeof obj.usage === "object" ? obj.usage : null;
  if (!u) return {};

  const usage = {};
  const pt = normalizeUsageInt(u.prompt_tokens);
  const ct = normalizeUsageInt(u.completion_tokens);
  if (pt != null) usage.usagePromptTokens = pt;
  if (ct != null) usage.usageCompletionTokens = ct;

  const ptd = u.prompt_tokens_details && typeof u.prompt_tokens_details === "object" ? u.prompt_tokens_details : null;
  if (ptd) {
    const cached = normalizeUsageInt(ptd.cached_tokens ?? ptd.cache_read_input_tokens ?? ptd.cache_read_tokens);
    const created = normalizeUsageInt(ptd.cache_creation_tokens ?? ptd.cache_creation_input_tokens);
    if (cached != null) usage.usageCacheReadInputTokens = cached;
    if (created != null) usage.usageCacheCreationInputTokens = created;
  }
  return usage;
}

async function* emitChatCompletionJsonAsAugmentChunks(json, { toolMetaByName, supportToolUseStart } = {}) {
  const obj = json && typeof json === "object" ? json : null;
  if (!obj) throw new Error("OpenAI(chat-stream) 响应不是有效 JSON");
  if (obj.error) {
    const msg = normalizeString(extractErrorMessageFromJson(obj)) || "upstream error";
    throw new Error(`OpenAI(chat-stream) upstream error: ${msg}`.trim());
  }

  const getToolMeta = makeToolMetaGetter(toolMetaByName);

  let nodeId = 0;
  const text = extractTextFromChatCompletionJson(obj);
  if (text) {
    nodeId += 1;
    yield makeBackChatChunk({ text, nodes: [rawResponseNode({ id: nodeId, content: text })] });
  }

  const thinking =
    normalizeString(obj?.choices?.[0]?.message?.reasoning) ||
    normalizeString(obj?.choices?.[0]?.message?.reasoning_content) ||
    normalizeString(obj?.choices?.[0]?.message?.thinking) ||
    normalizeString(obj?.choices?.[0]?.message?.thinking_content) ||
    "";
  if (thinking) {
    nodeId += 1;
    yield makeBackChatChunk({ text: "", nodes: [thinkingNode({ id: nodeId, summary: thinking })] });
  }

  let sawToolUse = false;
  const toolCalls = extractToolCallsFromChatCompletionJson(obj);
  for (const tc of toolCalls) {
    const toolName = normalizeString(tc?.name);
    if (!toolName) continue;
    const inputJson = normalizeString(tc?.args) || "{}";
    const meta = getToolMeta(toolName);
    const built = buildToolUseChunks({ nodeId, toolUseId: tc?.id, toolName, inputJson, meta, supportToolUseStart });
    nodeId = built.nodeId;
    for (const chunk of built.chunks) yield chunk;
    if (built.chunks.length) sawToolUse = true;
  }

  const usage = extractUsageFromChatCompletionJson(obj);
  const usageBuilt = buildTokenUsageChunk({
    nodeId,
    inputTokens: usage.usagePromptTokens,
    outputTokens: usage.usageCompletionTokens,
    cacheReadInputTokens: usage.usageCacheReadInputTokens,
    cacheCreationInputTokens: usage.usageCacheCreationInputTokens
  });
  nodeId = usageBuilt.nodeId;
  if (usageBuilt.chunk) yield usageBuilt.chunk;

  const { stopReason, stopReasonSeen } = extractStopReasonFromChatCompletionJson(obj);
  const final = buildFinalChatChunk({ nodeId, fullText: text, stopReasonSeen, stopReason, sawToolUse });
  yield final.chunk;
}

module.exports = { extractTextFromChatCompletionJson, emitChatCompletionJsonAsAugmentChunks };

