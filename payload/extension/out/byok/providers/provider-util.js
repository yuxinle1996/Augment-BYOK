"use strict";

const { normalizeString } = require("../infra/util");
const { readTextLimit } = require("./http");

function normalizeUsageInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function makeToolMetaGetter(toolMetaByName) {
  const map = toolMetaByName instanceof Map ? toolMetaByName : null;
  return (toolName) => {
    if (!map) return { mcpServerName: undefined, mcpToolName: undefined };
    const meta = map.get(toolName);
    return meta && typeof meta === "object" ? meta : { mcpServerName: undefined, mcpToolName: undefined };
  };
}

async function assertSseResponse(resp, { label, expectedHint, previewChars } = {}) {
  const contentType = normalizeString(resp?.headers?.get?.("content-type")).toLowerCase();
  if (contentType.includes("text/event-stream")) return;
  const lim = Number.isFinite(Number(previewChars)) && Number(previewChars) > 0 ? Number(previewChars) : 500;
  const preview = await readTextLimit(resp, lim);
  const hint = normalizeString(expectedHint) ? `；${String(expectedHint).trim()}` : "";
  throw new Error(`${normalizeString(label) || "SSE"} 响应不是 SSE（content-type=${contentType || "unknown"}）${hint}；body: ${preview}`.trim());
}

module.exports = { normalizeUsageInt, makeToolMetaGetter, assertSseResponse };

