"use strict";

const { normalizeString } = require("../infra/util");
const { debug } = require("../infra/log");
const shared = require("./augment-chat.shared");
const { repairOpenAiToolCallPairs } = require("./tool-pairing");
const { getChatHistoryAndRequestNodesForAPI } = require("./augment-history-summary");

function buildOpenAiMessageContent(segments) {
  return shared.buildTextOrPartsFromSegments(segments, {
    makeTextPart: (text) => ({ type: "text", text }),
    makeImagePart: ({ data, media_type }) => ({ type: "image_url", image_url: { url: `data:${media_type};base64,${data}` } })
  });
}

function buildOpenAiToolMessagesFromRequestNodes(nodes) {
  return shared.extractToolResultTextsFromRequestNodes(nodes).map((tr) => ({ role: "tool", tool_call_id: tr.toolUseId, content: tr.text }));
}

function buildOpenAiMessages(req) {
  const system = shared.buildSystemPrompt(req);
  const messages = [];
  if (normalizeString(system)) messages.push({ role: "system", content: system.trim() });

  const { processedHistory, processedRequestNodes } = getChatHistoryAndRequestNodesForAPI(req);
  const history = shared.asArray(processedHistory);

  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    const reqNodes = shared.collectExchangeRequestNodes(h);
    const content = buildOpenAiMessageContent(shared.buildUserSegmentsFromRequest(h.request_message, reqNodes));
    if (content) messages.push({ role: "user", content });
    const outNodes = shared.collectExchangeOutputNodes(h);
    const assistantText = normalizeString(h.response_text) ? h.response_text : shared.extractAssistantTextFromOutputNodes(outNodes);
    const toolCalls = shared.extractToolCallsFromOutputNodes(outNodes);
    if (normalizeString(assistantText) || toolCalls.length) messages.push({ role: "assistant", content: normalizeString(assistantText) ? assistantText.trim() : "", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    const next = i + 1 < history.length ? history[i + 1] : null;
    if (next) messages.push(...buildOpenAiToolMessagesFromRequestNodes(shared.collectExchangeRequestNodes(next)));
  }
  const currentNodesAll = shared.asArray(processedRequestNodes);
  messages.push(...buildOpenAiToolMessagesFromRequestNodes(currentNodesAll));
  const content = buildOpenAiMessageContent(shared.buildUserSegmentsWithExtraText(req, currentNodesAll));
  if (content) messages.push({ role: "user", content });
  const repaired = repairOpenAiToolCallPairs(messages);
  if (repaired?.report?.injected_missing_tool_results || repaired?.report?.converted_orphan_tool_results) {
    debug(
      `openai tool pairing repaired: injected_missing=${Number(repaired.report.injected_missing_tool_results) || 0} converted_orphan=${Number(repaired.report.converted_orphan_tool_results) || 0}`
    );
  }
  return repaired && Array.isArray(repaired.messages) ? repaired.messages : messages;
}

module.exports = { buildOpenAiMessages };
