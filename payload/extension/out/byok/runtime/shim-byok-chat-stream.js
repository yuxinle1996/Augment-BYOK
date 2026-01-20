"use strict";

const { normalizeString } = require("../infra/util");
const { providerLabel, providerRequestContext } = require("./shim-common");
const {
  captureAugmentChatToolDefinitions,
  summarizeAugmentChatRequest,
  isAugmentChatRequestEmpty,
  logAugmentChatStart,
  prepareAugmentChatRequestForByok,
  resolveSupportToolUseStart,
  resolveSupportParallelToolUse
} = require("./shim-augment-chat");
const {
  normalizeAugmentChatRequest,
  buildToolMetaByName
} = require("../core/augment-chat");
const { STOP_REASON_END_TURN, makeBackChatChunk } = require("../core/augment-protocol");
const { streamChatChunksByProvider } = require("./byok-chat-dispatch");

async function* byokChatStream({ cfg, provider, model, requestedModel, body, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken, requestId }) {
  const { type, baseUrl, apiKey, extraHeaders, requestDefaults } = providerRequestContext(provider);
  const req = normalizeAugmentChatRequest(body);
  const conversationId = normalizeString(req?.conversation_id ?? req?.conversationId ?? req?.conversationID);
  const rid = normalizeString(requestId);

  captureAugmentChatToolDefinitions({
    endpoint: "/chat-stream",
    req,
    provider,
    providerType: type,
    requestedModel,
    conversationId,
    requestId: rid
  });

  const summary = summarizeAugmentChatRequest(req);
  logAugmentChatStart({ kind: "chat-stream", requestId: rid, provider, providerType: type, model, requestedModel, conversationId, summary });
  if (isAugmentChatRequestEmpty(summary)) {
    yield makeBackChatChunk({ text: "", stop_reason: STOP_REASON_END_TURN });
    return;
  }

  const toolMetaByName = buildToolMetaByName(req.tool_definitions);
  const supportToolUseStart = resolveSupportToolUseStart(req);
  const supportParallelToolUse = resolveSupportParallelToolUse(req);
  const traceLabel = `[chat-stream] upstream${rid ? ` rid=${rid}` : ""} provider=${providerLabel(provider)} type=${type || "unknown"} model=${normalizeString(model) || "unknown"}`;

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
  const src = streamChatChunksByProvider({
    type,
    baseUrl,
    apiKey,
    model,
    req,
    timeoutMs,
    abortSignal,
    extraHeaders,
    requestDefaults,
    toolMetaByName,
    supportToolUseStart,
    supportParallelToolUse,
    traceLabel
  });

  if (!checkpointNotFound && workspaceFileChunks.length === 0) {
    yield* src;
    return;
  }

  let injectedWorkspaceChunks = false;
  for await (const chunk of src) {
    if (!chunk || typeof chunk !== "object") {
      yield chunk;
      continue;
    }
    const out = { ...chunk };
    if (checkpointNotFound) out.checkpoint_not_found = true;
    if (workspaceFileChunks.length && (!injectedWorkspaceChunks || out.stop_reason != null)) {
      out.workspace_file_chunks = workspaceFileChunks;
      injectedWorkspaceChunks = true;
    }
    yield out;
  }
}

module.exports = { byokChatStream };
