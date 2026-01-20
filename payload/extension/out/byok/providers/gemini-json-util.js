"use strict";

const { normalizeString } = require("../infra/util");
const { normalizeUsageInt, makeToolMetaGetter } = require("./provider-util");
const { extractErrorMessageFromJson } = require("./request-util");
const {
  STOP_REASON_END_TURN,
  STOP_REASON_MAX_TOKENS,
  STOP_REASON_SAFETY,
  STOP_REASON_RECITATION,
  STOP_REASON_MALFORMED_FUNCTION_CALL,
  rawResponseNode,
  makeBackChatChunk
} = require("../core/augment-protocol");
const { buildToolUseChunks, buildTokenUsageChunk, buildFinalChatChunk } = require("./chat-chunks-util");

function mapGeminiFinishReasonToAugment(reason) {
  const r = normalizeString(reason).trim().toUpperCase();
  if (r === "STOP") return STOP_REASON_END_TURN;
  if (r === "MAX_TOKENS") return STOP_REASON_MAX_TOKENS;
  if (r === "SAFETY") return STOP_REASON_SAFETY;
  if (r === "RECITATION") return STOP_REASON_RECITATION;
  if (r === "MALFORMED_FUNCTION_CALL") return STOP_REASON_MALFORMED_FUNCTION_CALL;
  return STOP_REASON_END_TURN;
}

function sanitizeToolHint(toolName) {
  const t = normalizeString(toolName);
  return t.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48) || "tool";
}

function normalizeFunctionCallArgsToJsonString(args) {
  if (typeof args === "string") return normalizeString(args) || "{}";
  if (args && typeof args === "object") {
    try {
      return JSON.stringify(args);
    } catch {
      return "{}";
    }
  }
  return "{}";
}

function extractGeminiUsageTokens(obj) {
  const json = obj && typeof obj === "object" ? obj : null;
  const um =
    (json?.usageMetadata && typeof json.usageMetadata === "object" ? json.usageMetadata : null) ||
    (json?.usage_metadata && typeof json.usage_metadata === "object" ? json.usage_metadata : null);
  if (!um) return {};

  const pt = normalizeUsageInt(um.promptTokenCount ?? um.prompt_token_count);
  const ct = normalizeUsageInt(um.candidatesTokenCount ?? um.candidates_token_count);
  const cached = normalizeUsageInt(um.cachedContentTokenCount ?? um.cached_content_token_count ?? um.cachedTokenCount);

  const out = {};
  if (pt != null) out.usagePromptTokens = pt;
  if (ct != null) out.usageCompletionTokens = ct;
  if (cached != null) out.usageCacheReadInputTokens = cached;
  return out;
}

function extractGeminiStopReasonFromCandidate(c0) {
  const cand = c0 && typeof c0 === "object" ? c0 : null;
  const fr = normalizeString(cand?.finishReason ?? cand?.finish_reason);
  if (!fr) return { stopReasonSeen: false, stopReason: null };
  return { stopReasonSeen: true, stopReason: mapGeminiFinishReasonToAugment(fr) };
}

function extractGeminiCandidate0(obj) {
  const candidates = Array.isArray(obj?.candidates) ? obj.candidates : [];
  return candidates[0] && typeof candidates[0] === "object" ? candidates[0] : null;
}

async function* emitGeminiPartsAsAugmentChunks(parts, { nodeIdStart, getToolMeta, supportToolUseStart }) {
  let nodeId = Number(nodeIdStart);
  if (!Number.isFinite(nodeId) || nodeId < 0) nodeId = 0;

  let fullText = "";
  let sawToolUse = false;
  let toolSeq = 0;

  let textBuf = "";
  const flushText = () => {
    if (!textBuf) return null;
    const t = textBuf;
    textBuf = "";
    if (!t) return null;
    fullText += t;
    nodeId += 1;
    return makeBackChatChunk({ text: t, nodes: [rawResponseNode({ id: nodeId, content: t })] });
  };

  const list = Array.isArray(parts) ? parts : [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    if (typeof p.text === "string" && p.text) {
      textBuf += p.text;
      continue;
    }
    const fc = p.functionCall && typeof p.functionCall === "object" ? p.functionCall : null;
    if (!fc) continue;

    const chunk = flushText();
    if (chunk) yield chunk;

    const toolName = normalizeString(fc.name);
    if (!toolName) continue;
    toolSeq += 1;
    const toolUseId = `tool-${sanitizeToolHint(toolName)}-${toolSeq}`;
    const inputJson = normalizeFunctionCallArgsToJsonString(fc.args ?? fc.arguments);
    const meta = getToolMeta(toolName);
    const built = buildToolUseChunks({ nodeId, toolUseId, toolName, inputJson, meta, supportToolUseStart });
    nodeId = built.nodeId;
    for (const c of built.chunks) yield c;
    if (built.chunks.length) sawToolUse = true;
  }

  const last = flushText();
  if (last) yield last;

  return { nodeId, fullText, sawToolUse };
}

async function* emitGeminiChatJsonAsAugmentChunks(json, { toolMetaByName, supportToolUseStart } = {}) {
  const obj = json && typeof json === "object" ? json : null;
  if (!obj) throw new Error("Gemini(chat-stream) 响应不是有效 JSON");
  if (obj && (obj.error || obj.message)) {
    const msg = normalizeString(extractErrorMessageFromJson(obj)) || "upstream error";
    throw new Error(`Gemini(chat-stream) upstream error: ${msg}`.trim());
  }

  const getToolMeta = makeToolMetaGetter(toolMetaByName);
  const usage = extractGeminiUsageTokens(obj);
  const c0 = extractGeminiCandidate0(obj);
  const stop = extractGeminiStopReasonFromCandidate(c0);
  const parts = Array.isArray(c0?.content?.parts) ? c0.content.parts : [];

  const emitted = yield* emitGeminiPartsAsAugmentChunks(parts, { nodeIdStart: 0, getToolMeta, supportToolUseStart });

  let nodeId = emitted.nodeId;
  const fullText = emitted.fullText;
  const sawToolUse = emitted.sawToolUse;

  const usageBuilt = buildTokenUsageChunk({
    nodeId,
    inputTokens: usage.usagePromptTokens,
    outputTokens: usage.usageCompletionTokens,
    cacheReadInputTokens: usage.usageCacheReadInputTokens
  });
  nodeId = usageBuilt.nodeId;
  if (usageBuilt.chunk) yield usageBuilt.chunk;

  const final = buildFinalChatChunk({
    nodeId,
    fullText,
    stopReasonSeen: stop.stopReasonSeen,
    stopReason: stop.stopReason,
    sawToolUse
  });
  yield final.chunk;
}

module.exports = {
  mapGeminiFinishReasonToAugment,
  sanitizeToolHint,
  normalizeFunctionCallArgsToJsonString,
  extractGeminiUsageTokens,
  extractGeminiStopReasonFromCandidate,
  emitGeminiChatJsonAsAugmentChunks
};

