"use strict";

const { normalizeString } = require("../infra/util");
const { truncateText } = require("../infra/text");
const { TOOL_RESULT_MISSING_MESSAGE } = require("./tool-pairing.common");

function normalizeItemType(item) {
  const t = normalizeString(item?.type).toLowerCase();
  return t || "message";
}

function normalizeCallId(v) {
  return normalizeString(v);
}

function normalizeFunctionCall(item) {
  const call_id = normalizeCallId(item?.call_id);
  if (!call_id) return null;
  return { call_id, name: normalizeString(item?.name), arguments: typeof item?.arguments === "string" ? item.arguments : "" };
}

function buildMissingOpenAiResponsesToolResultOutput(tc, opts) {
  const maxArgsLen = Number.isFinite(Number(opts?.maxArgsLen)) ? Number(opts.maxArgsLen) : 4000;
  const payload = {
    error: "tool_result_missing",
    call_id: normalizeCallId(tc?.call_id),
    tool_name: normalizeString(tc?.name) || undefined,
    message: TOOL_RESULT_MISSING_MESSAGE
  };
  const args = normalizeString(tc?.arguments);
  if (args) payload.arguments = truncateText(args, maxArgsLen);
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload.message || "tool_result_missing");
  }
}

function buildOrphanOpenAiResponsesToolResultAsUserMessage(item, opts) {
  const maxLen = Number.isFinite(Number(opts?.maxOrphanContentLen)) ? Number(opts.maxOrphanContentLen) : 8000;
  const callId = normalizeCallId(item?.call_id);
  const out = item?.output;
  const content = truncateText(typeof out === "string" ? out : JSON.stringify(out ?? null), maxLen).trim();
  const header = callId ? `[orphan_function_call_output call_id=${callId}]` : "[orphan_function_call_output]";
  return { type: "message", role: "user", content: content ? `${header}\n${content}` : header };
}

function repairOpenAiResponsesToolCallPairs(inputItems, opts) {
  const input = Array.isArray(inputItems) ? inputItems : [];
  const out = [];

  const report = {
    injected_missing_tool_results: 0,
    converted_orphan_tool_results: 0
  };

  let pending = null; // Map<string, {call_id,name,arguments}>
  let bufferedOrphanOutputs = null; // Array<item>

  const injectMissing = () => {
    if (!pending || pending.size === 0) {
      pending = null;
      return;
    }
    for (const tc of pending.values()) {
      out.push({ type: "function_call_output", call_id: tc.call_id, output: buildMissingOpenAiResponsesToolResultOutput(tc, opts) });
      report.injected_missing_tool_results += 1;
    }
    pending = null;
  };

  const bufferOrphanOutput = (item) => {
    if (!bufferedOrphanOutputs) bufferedOrphanOutputs = [];
    bufferedOrphanOutputs.push(item);
  };

  const flushBufferedOrphans = () => {
    if (!bufferedOrphanOutputs || bufferedOrphanOutputs.length === 0) {
      bufferedOrphanOutputs = null;
      return;
    }
    for (const item of bufferedOrphanOutputs) {
      out.push(buildOrphanOpenAiResponsesToolResultAsUserMessage(item, opts));
      report.converted_orphan_tool_results += 1;
    }
    bufferedOrphanOutputs = null;
  };

  const closePendingToolPhase = () => {
    injectMissing();
    flushBufferedOrphans();
  };

  for (const item of input) {
    const type = normalizeItemType(item);

    if (pending) {
      if (type === "function_call") {
        out.push(item);
        const tc = normalizeFunctionCall(item);
        if (tc && !pending.has(tc.call_id)) pending.set(tc.call_id, tc);
        continue;
      }
      if (type === "function_call_output") {
        const callId = normalizeCallId(item?.call_id);
        if (callId && pending.has(callId)) {
          pending.delete(callId);
          out.push(item);
          if (pending.size === 0) {
            pending = null;
            flushBufferedOrphans();
          }
        } else {
          bufferOrphanOutput(item);
        }
        continue;
      }

      closePendingToolPhase();
    }

    if (type === "function_call") {
      out.push(item);
      if (!pending) pending = new Map();
      const tc = normalizeFunctionCall(item);
      if (tc && !pending.has(tc.call_id)) pending.set(tc.call_id, tc);
      bufferedOrphanOutputs = null;
      continue;
    }
    if (type === "function_call_output") {
      out.push(buildOrphanOpenAiResponsesToolResultAsUserMessage(item, opts));
      report.converted_orphan_tool_results += 1;
      continue;
    }

    out.push(item);
  }

  closePendingToolPhase();
  return { input: out, report };
}

module.exports = { repairOpenAiResponsesToolCallPairs };

