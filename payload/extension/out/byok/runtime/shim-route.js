"use strict";

const { debug } = require("../infra/log");
const { ensureConfigManager, state } = require("../config/state");
const { decideRoute } = require("../core/router");
const { normalizeEndpoint, randomId } = require("../infra/util");
const { normalizeTimeoutMs, maybeDeleteHistorySummaryCacheForEndpoint, formatRouteForLog } = require("./shim-common");

async function resolveByokRouteContext({ endpoint, body, timeoutMs, logPrefix }) {
  const requestId = randomId();
  const ep = normalizeEndpoint(endpoint);
  if (!ep) return { requestId, ep: "", timeoutMs: 0, cfg: null, route: null, runtimeEnabled: false };

  await maybeDeleteHistorySummaryCacheForEndpoint(ep, body);

  const cfgMgr = ensureConfigManager();
  const cfg = cfgMgr.get();
  const t = normalizeTimeoutMs(timeoutMs);

  if (!state.runtimeEnabled) return { requestId, ep, timeoutMs: t, cfg, route: null, runtimeEnabled: false };

  const route = decideRoute({ cfg, endpoint: ep, body, runtimeEnabled: state.runtimeEnabled });
  debug(`[${String(logPrefix || "callApi")}] ${formatRouteForLog(route, { requestId })}`);
  return { requestId, ep, timeoutMs: t, cfg, route, runtimeEnabled: true };
}

module.exports = { resolveByokRouteContext };

