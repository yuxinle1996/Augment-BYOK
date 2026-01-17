"use strict";

const shared = require("./augment-chat.shared");
const openai = require("./augment-chat.openai");
const openaiResponses = require("./augment-chat.openai-responses");
const anthropic = require("./augment-chat.anthropic");
const gemini = require("./augment-chat.gemini");

module.exports = {
  normalizeAugmentChatRequest: shared.normalizeAugmentChatRequest,
  buildSystemPrompt: shared.buildSystemPrompt,
  convertOpenAiTools: shared.convertOpenAiTools,
  convertOpenAiResponsesTools: shared.convertOpenAiResponsesTools,
  convertAnthropicTools: shared.convertAnthropicTools,
  convertGeminiTools: shared.convertGeminiTools,
  buildToolMetaByName: shared.buildToolMetaByName,
  buildOpenAiMessages: openai.buildOpenAiMessages,
  buildOpenAiResponsesInput: openaiResponses.buildOpenAiResponsesInput,
  buildAnthropicMessages: anthropic.buildAnthropicMessages,
  buildGeminiContents: gemini.buildGeminiContents
};
