"use strict";

const { normalizeString } = require("../infra/util");
const { debug } = require("../infra/log");
const shared = require("./augment-chat.shared");
const { repairOpenAiResponsesToolCallPairs } = require("./tool-pairing");
const { getChatHistoryAndRequestNodesForAPI } = require("./augment-history-summary");

function buildResponsesMessageContent(segments) {
  return shared.buildTextOrPartsFromSegments(segments, {
    makeTextPart: (text) => ({ type: "input_text", text }),
    makeImagePart: ({ data, media_type }) => ({ type: "input_image", image_url: `data:${media_type};base64,${data}`, detail: "auto" })
  });
}

function buildFunctionCallOutputsFromRequestNodes(nodes) {
  return shared.extractToolResultTextsFromRequestNodes(nodes).map((tr) => ({ type: "function_call_output", call_id: tr.toolUseId, output: tr.text }));
}

function buildOpenAiResponsesInput(req) {
  const instructions = shared.buildSystemPrompt(req);
  const input = [];

  const { processedHistory, processedRequestNodes } = getChatHistoryAndRequestNodesForAPI(req);
  const history = shared.asArray(processedHistory);

  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    const reqNodesAll = shared.collectExchangeRequestNodes(h);
    const userContent = buildResponsesMessageContent(shared.buildUserSegmentsFromRequest(h.request_message, reqNodesAll));
    if (userContent) input.push({ type: "message", role: "user", content: userContent });

    const outNodes = shared.collectExchangeOutputNodes(h);
    const assistantText = normalizeString(h.response_text) ? h.response_text : shared.extractAssistantTextFromOutputNodes(outNodes);
    if (normalizeString(assistantText)) input.push({ type: "message", role: "assistant", content: assistantText.trim() });

    const toolCalls = shared.extractToolCallsFromOutputNodes(outNodes);
    for (const tc of toolCalls) {
      const call_id = normalizeString(tc?.id);
      const toolName = normalizeString(tc?.function?.name);
      const args = typeof tc?.function?.arguments === "string" ? tc.function.arguments : "";
      if (!call_id || !toolName) continue;
      input.push({ type: "function_call", call_id, name: toolName, arguments: normalizeString(args) || "{}" });
    }

    const next = i + 1 < history.length ? history[i + 1] : null;
    if (next) {
      input.push(...buildFunctionCallOutputsFromRequestNodes(shared.collectExchangeRequestNodes(next)));
    }
  }

  const currentNodesAll = shared.asArray(processedRequestNodes);
  input.push(...buildFunctionCallOutputsFromRequestNodes(currentNodesAll));

  const userContent = buildResponsesMessageContent(shared.buildUserSegmentsWithExtraText(req, currentNodesAll));
  if (userContent) input.push({ type: "message", role: "user", content: userContent });

  const repaired = repairOpenAiResponsesToolCallPairs(input);
  if (repaired?.report?.injected_missing_tool_results || repaired?.report?.converted_orphan_tool_results) {
    debug(
      `openai_responses tool pairing repaired: injected_missing=${Number(repaired.report.injected_missing_tool_results) || 0} converted_orphan=${Number(repaired.report.converted_orphan_tool_results) || 0}`
    );
  }

  return { instructions: normalizeString(instructions) ? instructions.trim() : "", input: repaired && Array.isArray(repaired.input) ? repaired.input : input };
}

module.exports = { buildOpenAiResponsesInput };
