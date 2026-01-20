"use strict";

const { TOOL_RESULT_MISSING_MESSAGE } = require("./tool-pairing.common");
const { repairOpenAiToolCallPairs } = require("./tool-pairing.openai");
const { repairOpenAiResponsesToolCallPairs } = require("./tool-pairing.openai-responses");
const { repairAnthropicToolUsePairs } = require("./tool-pairing.anthropic");

module.exports = { TOOL_RESULT_MISSING_MESSAGE, repairOpenAiToolCallPairs, repairOpenAiResponsesToolCallPairs, repairAnthropicToolUsePairs };
