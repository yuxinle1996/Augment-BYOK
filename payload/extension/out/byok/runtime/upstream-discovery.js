"use strict";

function getByokUpstreamGlobals() {
  const g = typeof globalThis !== "undefined" ? globalThis : null;
  const u = g && g.__augment_byok_upstream && typeof g.__augment_byok_upstream === "object" ? g.__augment_byok_upstream : null;
  return { global: g, upstream: u };
}

function isObject(v) {
  return v != null && typeof v === "object";
}

function findDeep(root, predicate, { maxDepth = 6, maxNodes = 5000 } = {}) {
  const start = isObject(root) ? root : null;
  if (!start) return null;
  if (typeof predicate !== "function") return null;
  if (predicate(start)) return start;

  const seen = new Set();
  const q = [{ v: start, d: 0 }];
  let qi = 0;

  const push = (v, d) => {
    if (!isObject(v)) return;
    if (seen.has(v)) return;
    if (seen.size >= maxNodes) return;
    seen.add(v);
    q.push({ v, d });
  };

  while (qi < q.length) {
    const cur = q[qi++];
    const v = cur?.v;
    const d = Number(cur?.d) || 0;
    if (!isObject(v)) continue;
    if (predicate(v)) return v;
    if (d >= maxDepth) continue;

    let keys = [];
    try {
      keys = Object.keys(v);
    } catch {
      keys = [];
    }
    for (const k of keys) {
      let child;
      try {
        child = v[k];
      } catch {
        child = null;
      }
      if (!isObject(child)) continue;
      if (predicate(child)) return child;
      push(child, d + 1);
    }
  }

  return null;
}

function createTimedCache(ttlMs) {
  const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Math.floor(Number(ttlMs)) : 0;
  let has = false;
  let cachedValue = null;
  let cachedAtMs = 0;

  const get = () => {
    if (!has) return undefined;
    if (!ttl) return cachedValue;
    if (Date.now() - cachedAtMs < ttl) return cachedValue;
    return undefined;
  };

  const set = (v) => {
    has = true;
    cachedValue = v == null ? null : v;
    cachedAtMs = Date.now();
    return cachedValue;
  };

  return { get, set };
}

module.exports = { getByokUpstreamGlobals, findDeep, createTimedCache };
