"use strict";

const { traceAsyncGenerator } = require("../infra/trace");
const {
  buildSystemPrompt,
  convertOpenAiTools,
  convertOpenAiResponsesTools,
  convertAnthropicTools,
  convertGeminiTools,
  buildOpenAiMessages,
  buildOpenAiResponsesInput,
  buildAnthropicMessages,
  buildGeminiContents
} = require("../core/augment-chat");
const { openAiCompleteText, openAiChatStreamChunks } = require("../providers/openai");
const { openAiResponsesCompleteText, openAiResponsesChatStreamChunks } = require("../providers/openai-responses");
const { anthropicCompleteText, anthropicChatStreamChunks } = require("../providers/anthropic");
const { geminiCompleteText, geminiChatStreamChunks } = require("../providers/gemini");

async function completeChatTextByProvider({
  type,
  baseUrl,
  apiKey,
  model,
  req,
  timeoutMs,
  abortSignal,
  extraHeaders,
  requestDefaults
}) {
  if (type === "openai_compatible") {
    return await openAiCompleteText({ baseUrl, apiKey, model, messages: buildOpenAiMessages(req), timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  if (type === "anthropic") {
    return await anthropicCompleteText({
      baseUrl,
      apiKey,
      model,
      system: buildSystemPrompt(req),
      messages: buildAnthropicMessages(req),
      timeoutMs,
      abortSignal,
      extraHeaders,
      requestDefaults
    });
  }
  if (type === "openai_responses") {
    const { instructions, input } = buildOpenAiResponsesInput(req);
    return await openAiResponsesCompleteText({ baseUrl, apiKey, model, instructions, input, timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  if (type === "gemini_ai_studio") {
    const { systemInstruction, contents } = buildGeminiContents(req);
    return await geminiCompleteText({ baseUrl, apiKey, model, systemInstruction, contents, timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function* streamChatChunksByProvider({
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
}) {
  if (type === "openai_compatible") {
    const gen = openAiChatStreamChunks({
      baseUrl,
      apiKey,
      model,
      messages: buildOpenAiMessages(req),
      tools: convertOpenAiTools(req.tool_definitions),
      timeoutMs,
      abortSignal,
      extraHeaders,
      requestDefaults,
      toolMetaByName,
      supportToolUseStart,
      supportParallelToolUse
    });
    yield* traceAsyncGenerator(`${traceLabel} openai_compatible`, gen);
    return;
  }
  if (type === "anthropic") {
    const gen = anthropicChatStreamChunks({
      baseUrl,
      apiKey,
      model,
      system: buildSystemPrompt(req),
      messages: buildAnthropicMessages(req),
      tools: convertAnthropicTools(req.tool_definitions),
      timeoutMs,
      abortSignal,
      extraHeaders,
      requestDefaults,
      toolMetaByName,
      supportToolUseStart
    });
    yield* traceAsyncGenerator(`${traceLabel} anthropic`, gen);
    return;
  }
  if (type === "openai_responses") {
    const { instructions, input } = buildOpenAiResponsesInput(req);
    const gen = openAiResponsesChatStreamChunks({
      baseUrl,
      apiKey,
      model,
      instructions,
      input,
      tools: convertOpenAiResponsesTools(req.tool_definitions),
      timeoutMs,
      abortSignal,
      extraHeaders,
      requestDefaults,
      toolMetaByName,
      supportToolUseStart,
      supportParallelToolUse
    });
    yield* traceAsyncGenerator(`${traceLabel} openai_responses`, gen);
    return;
  }
  if (type === "gemini_ai_studio") {
    const { systemInstruction, contents } = buildGeminiContents(req);
    const gen = geminiChatStreamChunks({
      baseUrl,
      apiKey,
      model,
      systemInstruction,
      contents,
      tools: convertGeminiTools(req.tool_definitions),
      timeoutMs,
      abortSignal,
      extraHeaders,
      requestDefaults,
      toolMetaByName,
      supportToolUseStart
    });
    yield* traceAsyncGenerator(`${traceLabel} gemini_ai_studio`, gen);
    return;
  }
  throw new Error(`未知 provider.type: ${type}`);
}

module.exports = { completeChatTextByProvider, streamChatChunksByProvider };

