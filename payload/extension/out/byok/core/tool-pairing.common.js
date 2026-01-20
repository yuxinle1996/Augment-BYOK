"use strict";

const { normalizeString } = require("../infra/util");

const TOOL_RESULT_MISSING_MESSAGE =
  "未收到对应的 tool_result（可能是工具未执行/被禁用/权限不足/或历史中丢失）。请在缺失结果的前提下继续推理或改为不依赖该工具。";

function normalizeRole(v) {
  return normalizeString(v).toLowerCase();
}

module.exports = { TOOL_RESULT_MISSING_MESSAGE, normalizeRole };

