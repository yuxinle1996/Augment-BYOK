"use strict";

const { warn } = require("../infra/log");
const { withTiming } = require("../infra/trace");
const { normalizeString, normalizeRawToken, safeTransform } = require("../infra/util");
const { getOfficialConnection } = require("../config/official");
const { fetchOfficialGetModels, mergeModels } = require("./official");
const {
  buildMessagesForEndpoint,
  makeBackTextResult,
  makeBackCompletionResult,
  makeBackNextEditLocationResult,
  buildByokModelsFromConfig,
  makeBackGetModelsResult,
  makeModelInfo
} = require("../core/protocol");
const { parseNextEditLocCandidatesFromText, mergeNextEditLocCandidates } = require("../core/next-edit-loc-utils");
const { pickPath, pickNumResults } = require("../core/next-edit-fields");
const { byokCompleteText } = require("./shim-byok-text");
const { byokChat } = require("./shim-byok-chat");
const { resolveByokRouteContext } = require("./shim-route");
const { maybeAugmentBodyWithWorkspaceBlob, pickNextEditLocationCandidates } = require("./shim-next-edit");
const { providerLabel } = require("./shim-common");

async function handleGetModels({ cfg, ep, transform, abortSignal, timeoutMs, upstreamApiToken, upstreamCompletionURL, requestId }) {
  const byokModels = buildByokModelsFromConfig(cfg);
  const byokDefaultModel = byokModels.length ? byokModels[0] : "";
  const activeProvider = Array.isArray(cfg?.providers) ? cfg.providers[0] : null;
  const activeProviderId = normalizeString(activeProvider?.id);
  const activeProviderDefaultModel = normalizeString(activeProvider?.defaultModel) || normalizeString(activeProvider?.models?.[0]);
  const preferredByok = activeProviderId && activeProviderDefaultModel ? `byok:${activeProviderId}:${activeProviderDefaultModel}` : "";
  const preferredDefaultModel = byokModels.includes(preferredByok) ? preferredByok : byokDefaultModel;

  try {
    const off = getOfficialConnection();
    const completionURL = normalizeString(upstreamCompletionURL) || off.completionURL;
    const apiToken = normalizeRawToken(upstreamApiToken) || off.apiToken;
    const upstream = await withTiming(`[callApi ${ep}] rid=${requestId} official/get-models`, async () =>
      await fetchOfficialGetModels({ completionURL, apiToken, timeoutMs: Math.min(12000, timeoutMs), abortSignal })
    );
    const merged = mergeModels(upstream, byokModels, { defaultModel: preferredDefaultModel });
    return safeTransform(transform, merged, ep);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn("get-models fallback to local", { requestId, error: msg });
    const local = makeBackGetModelsResult({ defaultModel: preferredDefaultModel || "unknown", models: byokModels.map(makeModelInfo) });
    return safeTransform(transform, local, ep);
  }
}

async function completeTextForEndpoint({ route, ep, body, timeoutMs, abortSignal, requestId, kind }) {
  const { system, messages } = buildMessagesForEndpoint(ep, body);
  const suffix = normalizeString(kind) || "complete";
  const label = `[callApi ${ep}] rid=${requestId} ${suffix} provider=${providerLabel(route.provider)} model=${normalizeString(route.model) || "unknown"}`;
  return await withTiming(label, async () =>
    await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs, abortSignal })
  );
}

async function handleCompletion({ route, ep, body, transform, timeoutMs, abortSignal, requestId }) {
  const text = await completeTextForEndpoint({ route, ep, body, timeoutMs, abortSignal, requestId, kind: "complete" });
  return safeTransform(transform, makeBackCompletionResult(text), ep);
}

async function handleEdit({ route, ep, body, transform, timeoutMs, abortSignal, requestId }) {
  const text = await completeTextForEndpoint({ route, ep, body, timeoutMs, abortSignal, requestId, kind: "edit" });
  return safeTransform(transform, makeBackTextResult(text), ep);
}

async function handleChat({ cfg, route, ep, body, transform, timeoutMs, abortSignal, upstreamApiToken, upstreamCompletionURL, requestId }) {
  const out = await byokChat({
    cfg,
    provider: route.provider,
    model: route.model,
    requestedModel: route.requestedModel,
    body,
    timeoutMs,
    abortSignal,
    upstreamCompletionURL,
    upstreamApiToken,
    requestId
  });
  return safeTransform(transform, out, ep);
}

async function handleNextEditLoc({ route, ep, body, transform, timeoutMs, abortSignal, requestId }) {
  const b = body && typeof body === "object" ? body : {};
  const max = pickNumResults(b, { defaultValue: 1, max: 6 });

  const baseline = pickNextEditLocationCandidates(body);
  const fallbackPath = pickPath(b) || normalizeString(baseline?.[0]?.item?.path);
  let llmCandidates = [];

  try {
    const bodyForPrompt = await maybeAugmentBodyWithWorkspaceBlob(body, { pathHint: fallbackPath });
    const text = await completeTextForEndpoint({ route, ep, body: bodyForPrompt, timeoutMs, abortSignal, requestId, kind: "llm" });
    llmCandidates = parseNextEditLocCandidatesFromText(text, { fallbackPath, max, source: "byok:llm" });
  } catch (err) {
    warn("next_edit_loc llm fallback to diagnostics", { requestId, error: err instanceof Error ? err.message : String(err) });
  }

  if (!llmCandidates.length) return safeTransform(transform, makeBackNextEditLocationResult(baseline), ep);
  const merged = mergeNextEditLocCandidates({ baseline, llmCandidates, max });
  return safeTransform(transform, makeBackNextEditLocationResult(merged), ep);
}

async function maybeHandleCallApi({ endpoint, body, transform, timeoutMs, abortSignal, upstreamApiToken, upstreamCompletionURL }) {
  const { requestId, ep, timeoutMs: t, cfg, route, runtimeEnabled } = await resolveByokRouteContext({
    endpoint,
    body,
    timeoutMs,
    logPrefix: "callApi"
  });
  if (!ep) return undefined;
  if (!runtimeEnabled) return undefined;
  if (route.mode === "official") return undefined;
  if (route.mode === "disabled") {
    try {
      return safeTransform(transform, {}, `disabled:${ep}`);
    } catch {
      return {};
    }
  }
  if (route.mode !== "byok") return undefined;

  try {
    if (ep === "/get-models") {
      return await handleGetModels({ cfg, ep, transform, abortSignal, timeoutMs: t, upstreamApiToken, upstreamCompletionURL, requestId });
    }
    if (ep === "/completion" || ep === "/chat-input-completion") {
      return await handleCompletion({ route, ep, body, transform, timeoutMs: t, abortSignal, requestId });
    }
    if (ep === "/edit") {
      return await handleEdit({ route, ep, body, transform, timeoutMs: t, abortSignal, requestId });
    }
    if (ep === "/chat") {
      return await handleChat({ cfg, route, ep, body, transform, timeoutMs: t, abortSignal, upstreamApiToken, upstreamCompletionURL, requestId });
    }
    if (ep === "/next_edit_loc") {
      return await handleNextEditLoc({ route, ep, body, transform, timeoutMs: t, abortSignal, requestId });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn("callApi BYOK failed, fallback official", { requestId, endpoint: ep, error: msg });
    return undefined;
  }

  return undefined;
}

module.exports = { maybeHandleCallApi };
