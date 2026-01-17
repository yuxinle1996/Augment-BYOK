"use strict";

const { normalizeRawToken } = require("../infra/util");

function withJsonContentType(headers) {
  return { "content-type": "application/json", ...(headers && typeof headers === "object" ? headers : {}) };
}

function openAiAuthHeaders(apiKey, extraHeaders) {
  const key = normalizeRawToken(apiKey);
  const headers = { ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}) };
  const hasAuthHeader = Object.keys(headers).some((k) => String(k || "").trim().toLowerCase() === "authorization");
  if (!hasAuthHeader && key) headers.authorization = `Bearer ${key}`;
  return headers;
}

function anthropicAuthHeaders(apiKey, extraHeaders, opts) {
  const key = normalizeRawToken(apiKey);
  const forceBearer = opts && typeof opts === "object" ? Boolean(opts.forceBearer) : false;
  const headers = { ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}) };
  const lowerKeys = new Set(Object.keys(headers).map((k) => String(k || "").trim().toLowerCase()));
  if (!lowerKeys.has("x-api-key") && key) headers["x-api-key"] = key;
  if (!lowerKeys.has("anthropic-version")) headers["anthropic-version"] = "2023-06-01";
  if (forceBearer && !lowerKeys.has("authorization") && key) headers.authorization = `Bearer ${key}`;
  return headers;
}

module.exports = { withJsonContentType, openAiAuthHeaders, anthropicAuthHeaders };
