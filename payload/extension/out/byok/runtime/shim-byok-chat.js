"use strict";

const { withTiming } = require("../infra/trace");
const { normalizeString } = require("../infra/util");
const { makeBackChatResult } = require("../core/protocol");
const { providerLabel, providerRequestContext } = require("./shim-common");
const {
  captureAugmentChatToolDefinitions,
  summarizeAugmentChatRequest,
  isAugmentChatRequestEmpty,
  logAugmentChatStart,
  prepareAugmentChatRequestForByok
} = require("./shim-augment-chat");
const { normalizeAugmentChatRequest } = require("../core/augment-chat");
const { completeChatTextByProvider } = require("./byok-chat-dispatch");

async function byokChat({ cfg, provider, model, requestedModel, body, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken, requestId }) {
  const { type, baseUrl, apiKey, extraHeaders, requestDefaults } = providerRequestContext(provider);
  const req = normalizeAugmentChatRequest(body);
  const conversationId = normalizeString(req?.conversation_id ?? req?.conversationId ?? req?.conversationID);
  const rid = normalizeString(requestId);

  captureAugmentChatToolDefinitions({
    endpoint: "/chat",
    req,
    provider,
    providerType: type,
    requestedModel,
    conversationId,
    requestId: rid
  });

  const summary = summarizeAugmentChatRequest(req);
  logAugmentChatStart({ kind: "chat", requestId: rid, provider, providerType: type, model, requestedModel, conversationId, summary });
  if (isAugmentChatRequestEmpty(summary)) return makeBackChatResult("", { nodes: [] });

  const prep = await prepareAugmentChatRequestForByok({
    cfg,
    req,
    requestedModel,
    fallbackProvider: provider,
    fallbackModel: model,
    timeoutMs,
    abortSignal,
    upstreamCompletionURL,
    upstreamApiToken,
    requestId: rid
  });
  const checkpointNotFound = prep && typeof prep === "object" && prep.checkpointNotFound === true;
  const workspaceFileChunks = prep && typeof prep === "object" && Array.isArray(prep.workspaceFileChunks) ? prep.workspaceFileChunks : [];

  const traceLabel = `[chat] upstream${rid ? ` rid=${rid}` : ""} provider=${providerLabel(provider)} type=${type || "unknown"} model=${normalizeString(model) || "unknown"}`;
  const text = await withTiming(traceLabel, async () =>
    await completeChatTextByProvider({ type, baseUrl, apiKey, model, req, timeoutMs, abortSignal, extraHeaders, requestDefaults })
  );

  const out = makeBackChatResult(text, { nodes: [] });
  if (checkpointNotFound) out.checkpoint_not_found = true;
  if (workspaceFileChunks.length) out.workspace_file_chunks = workspaceFileChunks;
  return out;
}

module.exports = { byokChat };
