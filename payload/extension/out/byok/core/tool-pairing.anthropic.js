"use strict";

const { normalizeString } = require("../infra/util");
const { normalizeAnthropicBlocks, buildOrphanAnthropicToolResultAsTextBlock } = require("./anthropic-blocks");
const { TOOL_RESULT_MISSING_MESSAGE, normalizeRole } = require("./tool-pairing.common");

function buildMissingAnthropicToolResultBlock({ toolUseId, toolName, input } = {}) {
  const payload = {
    error: "tool_result_missing",
    tool_use_id: String(toolUseId || ""),
    tool_name: normalizeString(toolName) || undefined,
    message: TOOL_RESULT_MISSING_MESSAGE
  };
  if (input && typeof input === "object" && !Array.isArray(input)) payload.input = input;
  let content;
  try {
    content = JSON.stringify(payload);
  } catch {
    content = String(payload.message || "tool_result_missing");
  }
  return { type: "tool_result", tool_use_id: String(toolUseId || ""), content, is_error: true };
}

function repairAnthropicToolUsePairs(messages, opts) {
  const input = Array.isArray(messages) ? messages : [];
  const out = [];

  const report = {
    injected_missing_tool_results: 0,
    converted_orphan_tool_results: 0
  };

  let pending = null; // Map<string, {toolUseId, toolName, input}>

  const injectMissing = () => {
    if (!pending || pending.size === 0) {
      pending = null;
      return;
    }
    const blocks = [];
    for (const tc of pending.values()) {
      blocks.push(buildMissingAnthropicToolResultBlock({ toolUseId: tc.toolUseId, toolName: tc.toolName, input: tc.input }));
      report.injected_missing_tool_results += 1;
    }
    out.push({ role: "user", content: blocks });
    pending = null;
  };

  for (const msg of input) {
    const role = normalizeRole(msg?.role);

    if (pending) {
      if (role === "user") {
        const blocks = normalizeAnthropicBlocks(msg?.content);
        const toolResultBlocks = [];
        const otherBlocks = [];
        let changed = false;
        let sawToolResult = false;
        let sawNonToolBeforeToolResult = false;

        for (const b of blocks) {
          if (b.type === "tool_result") {
            sawToolResult = true;
            if (sawNonToolBeforeToolResult) changed = true;
            const id = normalizeString(b.tool_use_id);
            if (id && pending.has(id)) {
              pending.delete(id);
              toolResultBlocks.push(b);
            } else {
              otherBlocks.push(buildOrphanAnthropicToolResultAsTextBlock(b, opts));
              report.converted_orphan_tool_results += 1;
              changed = true;
            }
          } else {
            if (!sawToolResult) sawNonToolBeforeToolResult = true;
            otherBlocks.push(b);
          }
        }

        if (pending.size) {
          for (const tc of pending.values()) {
            toolResultBlocks.push(buildMissingAnthropicToolResultBlock({ toolUseId: tc.toolUseId, toolName: tc.toolName, input: tc.input }));
            report.injected_missing_tool_results += 1;
          }
          pending = null;
          changed = true;
        } else pending = null;

        const newBlocks = toolResultBlocks.length ? [...toolResultBlocks, ...otherBlocks] : otherBlocks;
        out.push(changed ? { ...msg, content: newBlocks } : msg);
        continue;
      }

      injectMissing();
    }

    if (role === "assistant") {
      out.push(msg);
      const blocks = normalizeAnthropicBlocks(msg?.content);
      const toolUses = blocks.filter((b) => b && b.type === "tool_use" && normalizeString(b.id) && normalizeString(b.name));
      if (toolUses.length) {
        const m = new Map();
        for (const b of toolUses) {
          const toolUseId = normalizeString(b.id);
          if (m.has(toolUseId)) continue;
          m.set(toolUseId, { toolUseId, toolName: normalizeString(b.name), input: b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : undefined });
        }
        pending = m.size ? m : null;
      }
      continue;
    }

    if (role === "user") {
      const blocks = normalizeAnthropicBlocks(msg?.content);
      const hasOrphanToolResult = blocks.some((b) => b && b.type === "tool_result");
      if (hasOrphanToolResult) {
        const newBlocks = [];
        for (const b of blocks) {
          if (b && b.type === "tool_result") {
            newBlocks.push(buildOrphanAnthropicToolResultAsTextBlock(b, opts));
            report.converted_orphan_tool_results += 1;
          } else newBlocks.push(b);
        }
        out.push({ ...msg, content: newBlocks });
      } else out.push(msg);
      continue;
    }

    out.push(msg);
  }

  injectMissing();
  return { messages: out, report };
}

module.exports = { repairAnthropicToolUsePairs };

