"use strict";

const { normalizeString } = require("../infra/util");
const { truncateText } = require("../infra/text");
const { TOOL_RESULT_MISSING_MESSAGE, normalizeRole } = require("./tool-pairing.common");

function normalizeToolCall(tc) {
  const rec = tc && typeof tc === "object" ? tc : {};
  const fn = rec.function && typeof rec.function === "object" ? rec.function : {};
  const id = normalizeString(rec.id);
  if (!id) return null;
  return {
    id,
    name: normalizeString(fn.name),
    arguments: typeof fn.arguments === "string" ? fn.arguments : ""
  };
}

function buildMissingToolResultContent(tc, opts) {
  const maxArgsLen = Number.isFinite(Number(opts?.maxArgsLen)) ? Number(opts.maxArgsLen) : 4000;
  const payload = {
    error: "tool_result_missing",
    tool_call_id: normalizeString(tc?.id),
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

function buildOrphanToolResultAsUserContent(msg, opts) {
  const maxLen = Number.isFinite(Number(opts?.maxOrphanContentLen)) ? Number(opts.maxOrphanContentLen) : 8000;
  const id = normalizeString(msg?.tool_call_id);
  const content = truncateText(typeof msg?.content === "string" ? msg.content : String(msg?.content ?? ""), maxLen).trim();
  const header = id ? `[orphan_tool_result tool_call_id=${id}]` : "[orphan_tool_result]";
  return content ? `${header}\n${content}` : header;
}

function repairOpenAiToolCallPairs(messages, opts) {
  const input = Array.isArray(messages) ? messages : [];
  const out = [];

  const report = {
    injected_missing_tool_results: 0,
    converted_orphan_tool_results: 0
  };

  let pending = null; // Map<string, {id,name,arguments}>
  let bufferedOrphanToolMessages = null; // Array<msg>

  const injectMissing = () => {
    if (!pending || pending.size === 0) {
      pending = null;
      return;
    }
    for (const tc of pending.values()) {
      out.push({ role: "tool", tool_call_id: tc.id, content: buildMissingToolResultContent(tc, opts) });
      report.injected_missing_tool_results += 1;
    }
    pending = null;
  };

  const handleOrphanTool = (msg) => {
    out.push({ role: "user", content: buildOrphanToolResultAsUserContent(msg, opts) });
    report.converted_orphan_tool_results += 1;
  };

  const bufferOrphanTool = (msg) => {
    if (!bufferedOrphanToolMessages) bufferedOrphanToolMessages = [];
    bufferedOrphanToolMessages.push(msg);
  };

  const flushBufferedOrphans = () => {
    if (!bufferedOrphanToolMessages || bufferedOrphanToolMessages.length === 0) {
      bufferedOrphanToolMessages = null;
      return;
    }
    for (const msg of bufferedOrphanToolMessages) handleOrphanTool(msg);
    bufferedOrphanToolMessages = null;
  };

  const closePendingToolPhase = () => {
    injectMissing();
    flushBufferedOrphans();
  };

  for (const msg of input) {
    const role = normalizeRole(msg?.role);

    if (pending) {
      if (role === "tool") {
        const id = normalizeString(msg?.tool_call_id);
        if (id && pending.has(id)) {
          pending.delete(id);
          out.push(msg);
          if (pending.size === 0) {
            pending = null;
            flushBufferedOrphans();
          }
        } else {
          bufferOrphanTool(msg);
        }
        continue;
      }

      closePendingToolPhase();
    }

    if (role === "assistant" && Array.isArray(msg?.tool_calls) && msg.tool_calls.length) {
      out.push(msg);
      const m = new Map();
      for (const raw of msg.tool_calls) {
        const tc = normalizeToolCall(raw);
        if (!tc) continue;
        if (m.has(tc.id)) continue;
        m.set(tc.id, tc);
      }
      pending = m.size ? m : null;
      bufferedOrphanToolMessages = null;
      continue;
    }

    if (role === "tool") {
      handleOrphanTool(msg);
      continue;
    }

    out.push(msg);
  }

  closePendingToolPhase();
  return { messages: out, report };
}

module.exports = { repairOpenAiToolCallPairs };

